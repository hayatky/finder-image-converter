import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import {
  extensionForFormat,
  resolveOutputDir,
  reserveUniqueOutputPath,
  createTempPath,
  commitTempFile,
  safeUnlink,
} from './file-manager.mjs';

const execFileAsync = promisify(execFile);

// Limit sharp memory footprint for large batch jobs.
sharp.cache(false);
sharp.concurrency(2);

export const SUPPORTED_INPUT_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.avif',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
  '.gif',
]);

export function isSupportedImagePath(filePath) {
  const ext = path.extname(String(filePath ?? '')).toLowerCase();
  return SUPPORTED_INPUT_EXTENSIONS.has(ext);
}

async function convertHeicInputWithSips(inputPath) {
  const rand = crypto.randomBytes(6).toString('hex');
  const tmpTiff = path.join(os.tmpdir(), `imgresize-heic-in-${process.pid}-${rand}.tiff`);
  try {
    await execFileAsync('/usr/bin/sips', ['-s', 'format', 'tiff', inputPath, '--out', tmpTiff], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return tmpTiff;
  } catch (err) {
    await safeUnlink(tmpTiff);
    throw new Error(`HEIC/HEIF decode via sips failed: ${err.message}`);
  }
}

async function encodeHeicOutputWithSips(intermediatePath, targetPath, quality) {
  const q = Math.max(1, Math.min(100, Math.round(quality ?? 80)));
  await execFileAsync(
    '/usr/bin/sips',
    ['-s', 'format', 'heic', '-s', 'formatOptions', String(q), intermediatePath, '--out', targetPath],
    { maxBuffer: 10 * 1024 * 1024 }
  );
}

/**
 * Inspect input image metadata, falling back to macOS sips for HEIC/HEIF if libheif lacks HEVC decoder.
 */
async function prepareInputSource(inputPath) {
  try {
    const instance = sharp(inputPath, { failOn: 'error', limitInputPixels: 268402689 });
    const metadata = await instance.metadata();
    // Attempt a quick 1x1 decode check only for HEIC/HEIF because metadata() can succeed while HEVC decode fails.
    const ext = path.extname(inputPath).toLowerCase();
    if (ext === '.heic' || ext === '.heif') {
      await sharp(inputPath).resize(1, 1).raw().toBuffer();
    }
    return { sourcePath: inputPath, metadata, tempInputPath: null };
  } catch (err) {
    const ext = path.extname(inputPath).toLowerCase();
    if (ext === '.heic' || ext === '.heif') {
      const tempInputPath = await convertHeicInputWithSips(inputPath);
      const metadata = await sharp(tempInputPath, { failOn: 'error' }).metadata();
      return { sourcePath: tempInputPath, metadata, tempInputPath };
    }
    throw err;
  }
}

/**
 * Process a single image according to preset/options without ever modifying the source file.
 *
 * @param {string} inputPath
 * @param {object} options
 * @returns {Promise<object>} Result summary with paths, dimensions, and byte sizes
 */
export async function processImage(inputPath, options) {
  const resolvedInput = path.resolve(inputPath);
  const inputStat = await fs.stat(resolvedInput);
  if (!inputStat.isFile()) {
    throw new Error(`Not a regular file: ${resolvedInput}`);
  }

  const format = String(options.format ?? 'jpeg').toLowerCase();
  const quality = Math.max(1, Math.min(100, Math.round(Number(options.quality ?? 85))));
  const resizeMode = options.resizeMode ?? 'longEdge';
  const withoutEnlargement = options.withoutEnlargement !== false;
  const stripMetadata = options.stripMetadata !== false;
  const convertToSrgb = options.convertToSrgb !== false;
  const outputDir = resolveOutputDir(resolvedInput, options.outputDir ?? 'Resized');
  const outExt = extensionForFormat(format);

  let tempInputPath = null;
  let tempOutputPath = null;
  let tempHeicStagePath = null;
  let reservedDestPath = null;

  try {
    const prepared = await prepareInputSource(resolvedInput);
    tempInputPath = prepared.tempInputPath;
    const { sourcePath, metadata } = prepared;

    reservedDestPath = await reserveUniqueOutputPath(resolvedInput, outputDir, format);
    tempOutputPath = createTempPath(outputDir, outExt);

    let pipeline = sharp(sourcePath, {
      failOn: 'error',
      limitInputPixels: 268402689,
    });

    // 1. Apply EXIF orientation to pixels so orientation is always preserved
    //    even when EXIF metadata is stripped.
    pipeline = pipeline.rotate();

    // 2. Resize while maintaining aspect ratio and preventing upscaling by default.
    if (resizeMode === 'longEdge' && options.maxLongEdge) {
      const maxEdge = Number(options.maxLongEdge);
      pipeline = pipeline.resize({
        width: maxEdge,
        height: maxEdge,
        fit: 'inside',
        withoutEnlargement,
        kernel: sharp.kernel.lanczos3,
      });
    } else if (resizeMode === 'dimensions' && (options.width || options.height)) {
      pipeline = pipeline.resize({
        width: options.width ? Number(options.width) : undefined,
        height: options.height ? Number(options.height) : undefined,
        fit: 'inside',
        withoutEnlargement,
        kernel: sharp.kernel.lanczos3,
      });
    }

    // 3. Handle transparency safely when converting to formats without alpha (JPEG).
    if (format === 'jpeg' && metadata.hasAlpha) {
      pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
    }

    // 4. Color management & metadata handling.
    //    - When convertToSrgb is true, convert pixels to sRGB via LittleCMS2 and attach
    //      a standard sRGB ICC profile so colors stay identical across browsers and macOS apps.
    //    - When stripMetadata is true (default), EXIF/GPS/XMP/IPTC are all stripped by sharp.
    //    - When stripMetadata is false, preserve EXIF/XMP/IPTC (sharp automatically normalizes
    //      EXIF Orientation to 1 after .rotate()).
    if (!stripMetadata) {
      pipeline = pipeline.keepMetadata();
      if (convertToSrgb) {
        pipeline = pipeline.toColorspace('srgb').withIccProfile('srgb');
      }
      // Reset orientation tag to 1 because pixels have already been physically rotated.
      pipeline = pipeline.withExifMerge({
        IFD0: { Orientation: '1' },
      });
    } else if (convertToSrgb) {
      pipeline = pipeline.toColorspace('srgb').withIccProfile('srgb');
    } else {
      pipeline = pipeline.keepIccProfile();
    }

    // 5. Encode according to target format.
    let outputInfo;
    if (format === 'jpeg') {
      outputInfo = await pipeline
        .jpeg({
          quality,
          mozjpeg: true,
          progressive: true,
          chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0',
        })
        .toFile(tempOutputPath);
    } else if (format === 'png') {
      outputInfo = await pipeline
        .png({
          compressionLevel: 9,
          adaptiveFiltering: true,
        })
        .toFile(tempOutputPath);
    } else if (format === 'webp') {
      outputInfo = await pipeline
        .webp({
          quality,
          effort: 5,
          smartSubsample: true,
        })
        .toFile(tempOutputPath);
    } else if (format === 'avif') {
      outputInfo = await pipeline
        .avif({
          quality,
          effort: 4,
          chromaSubsampling: quality >= 85 ? '4:4:4' : '4:2:0',
        })
        .toFile(tempOutputPath);
    } else if (format === 'tiff') {
      outputInfo = await pipeline
        .tiff({
          quality,
          compression: 'lzw',
        })
        .toFile(tempOutputPath);
    } else if (format === 'heic') {
      tempHeicStagePath = createTempPath(outputDir, '.tiff');
      outputInfo = await pipeline
        .tiff({ compression: 'deflate' })
        .toFile(tempHeicStagePath);
      await encodeHeicOutputWithSips(tempHeicStagePath, tempOutputPath, quality);
      const outStat = await fs.stat(tempOutputPath);
      outputInfo = { ...outputInfo, size: outStat.size, format: 'heic' };
    } else {
      throw new Error(`Unsupported output format: ${format}`);
    }

    // 6. Atomically commit the finished output into the reserved path.
    await commitTempFile(tempOutputPath, reservedDestPath);
    tempOutputPath = null; // committed

    return {
      ok: true,
      inputPath: resolvedInput,
      outputPath: reservedDestPath,
      inputBytes: inputStat.size,
      outputBytes: outputInfo.size,
      width: outputInfo.width,
      height: outputInfo.height,
      format,
    };
  } catch (err) {
    // Clean up temporary files and the empty reservation file on failure.
    await safeUnlink(tempOutputPath);
    await safeUnlink(reservedDestPath);
    throw err;
  } finally {
    await safeUnlink(tempInputPath);
    await safeUnlink(tempHeicStagePath);
  }
}
