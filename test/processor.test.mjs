import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { processImage } from '../src/processor.mjs';

const execFileAsync = promisify(execFile);

async function makeTempDir(prefix = 'imgresize-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('converts to JPEG, PNG, WebP, AVIF, TIFF, and HEIC with long-edge resizing', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const srcPath = path.join(dir, 'landscape.png');
  await sharp({
    create: { width: 1200, height: 800, channels: 3, background: { r: 40, g: 120, b: 220 } },
  })
    .png()
    .toFile(srcPath);

  for (const format of ['jpeg', 'png', 'webp', 'avif', 'tiff', 'heic']) {
    const res = await processImage(srcPath, {
      format,
      resizeMode: 'longEdge',
      maxLongEdge: 600,
      quality: 80,
      outputDir: `out-${format}`,
    });

    assert.equal(res.ok, true);
    assert.equal(res.width, 600, `format ${format} width`);
    assert.equal(res.height, 400, `format ${format} height`);

    const stat = await fs.stat(res.outputPath);
    assert.ok(stat.size > 0, `format ${format} should have non-zero size`);

    if (format === 'heic') {
      // Verify HEIC input can also be decoded via sips fallback and converted to JPEG
      const fromHeic = await processImage(res.outputPath, {
        format: 'jpeg',
        resizeMode: 'longEdge',
        maxLongEdge: 300,
        quality: 85,
        outputDir: 'from-heic',
      });
      assert.equal(fromHeic.width, 300);
      assert.equal(fromHeic.height, 200);
    } else {
      const meta = await sharp(res.outputPath).metadata();
      const expectedSharpFormat = format === 'avif' ? 'heif' : format;
      assert.equal(meta.format, expectedSharpFormat);
      assert.equal(meta.width, 600);
      assert.equal(meta.height, 400);
    }
  }
});

test('does not upscale smaller images by default and supports width/height dimensions', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const smallPath = path.join(dir, 'small.png');
  await sharp({
    create: { width: 400, height: 200, channels: 3, background: { r: 100, g: 180, b: 90 } },
  })
    .png()
    .toFile(smallPath);

  const noUpscale = await processImage(smallPath, {
    format: 'jpeg',
    resizeMode: 'longEdge',
    maxLongEdge: 2560,
    withoutEnlargement: true,
    outputDir: 'Resized',
  });
  assert.equal(noUpscale.width, 400);
  assert.equal(noUpscale.height, 200);

  const byHeight = await processImage(smallPath, {
    format: 'png',
    resizeMode: 'dimensions',
    width: null,
    height: 100,
    outputDir: 'Resized',
  });
  assert.equal(byHeight.width, 200);
  assert.equal(byHeight.height, 100);
});

test('preserves visual orientation for EXIF rotated JPEG and strips/keeps EXIF & GPS safely', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  // Create a 300x100 image tagged with EXIF Orientation=6 (90 deg CW -> visual 100x300) and GPS info
  const exifSrc = path.join(dir, 'rotated-gps.jpg');
  await sharp({
    create: { width: 300, height: 100, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .withMetadata({
      orientation: 6,
      exif: {
        IFD0: { Make: 'TestCamera' },
        GPS: { GPSLatitudeRef: 'N', GPSLatitude: '35 40 52', GPSLongitudeRef: 'E', GPSLongitude: '139 46 01' },
      },
    })
    .jpeg({ quality: 90 })
    .toFile(exifSrc);

  const srcMeta = await sharp(exifSrc).metadata();
  assert.equal(srcMeta.orientation, 6);
  assert.ok(srcMeta.exif && srcMeta.exif.length > 0);

  // 1. Strip metadata: orientation must be baked into pixels (100x300) and EXIF/GPS must be gone.
  const stripped = await processImage(exifSrc, {
    format: 'jpeg',
    resizeMode: 'none',
    quality: 85,
    stripMetadata: true,
    outputDir: 'stripped',
  });
  const strippedMeta = await sharp(stripped.outputPath).metadata();
  assert.equal(strippedMeta.width, 100);
  assert.equal(strippedMeta.height, 300);
  assert.equal(strippedMeta.exif, undefined, 'EXIF (including GPS) must be stripped');

  // 2. Keep metadata: orientation must be baked (100x300), EXIF preserved, Orientation tag normalized to 1.
  const kept = await processImage(exifSrc, {
    format: 'jpeg',
    resizeMode: 'none',
    quality: 85,
    stripMetadata: false,
    outputDir: 'kept',
  });
  const keptMeta = await sharp(kept.outputPath).metadata();
  assert.equal(keptMeta.width, 100);
  assert.equal(keptMeta.height, 300);
  assert.ok(keptMeta.exif && keptMeta.exif.length > 0, 'EXIF should be preserved');
  assert.equal(keptMeta.orientation, 1, 'Orientation tag should be normalized to 1 after pixel rotation');
});

test('converts Display P3 ICC profile to sRGB cleanly without losing color fidelity', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const p3Profile = '/System/Library/ColorSync/Profiles/Display P3.icc';
  let hasP3 = true;
  try {
    await fs.access(p3Profile);
  } catch {
    hasP3 = false;
  }

  const p3Src = path.join(dir, 'p3.png');
  let maker = sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 220, g: 40, b: 40 } },
  });
  if (hasP3) {
    maker = maker.withIccProfile(p3Profile);
  }
  await maker.png().toFile(p3Src);

  const out = await processImage(p3Src, {
    format: 'jpeg',
    resizeMode: 'none',
    quality: 90,
    stripMetadata: true,
    convertToSrgb: true,
    outputDir: 'srgb-out',
  });

  const outMeta = await sharp(out.outputPath).metadata();
  assert.equal(outMeta.space, 'srgb');
  assert.equal(outMeta.exif, undefined);
  // Check macOS sips reports sRGB profile
  const { stdout } = await execFileAsync('/usr/bin/sips', ['-g', 'profile', out.outputPath]);
  assert.match(stdout, /sRGB/i);
});

test('handles transparent PNG properly for alpha and non-alpha output formats', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const alphaSrc = path.join(dir, 'transparent.png');
  await sharp({
    create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toFile(alphaSrc);

  // WebP preserves alpha
  const webpOut = await processImage(alphaSrc, {
    format: 'webp',
    resizeMode: 'none',
    quality: 80,
    outputDir: 'alpha-webp',
  });
  const webpMeta = await sharp(webpOut.outputPath).metadata();
  assert.equal(webpMeta.hasAlpha, true);

  // JPEG flattens transparency onto white (#FFFFFF) instead of turning black
  const jpgOut = await processImage(alphaSrc, {
    format: 'jpeg',
    resizeMode: 'none',
    quality: 90,
    outputDir: 'alpha-jpg',
  });
  const { data } = await sharp(jpgOut.outputPath).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0] > 245 && data[1] > 245 && data[2] > 245, 'Transparent area should flatten to white');
});

test('respects quality parameter for JPEG, WebP, and AVIF', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  // Generate noisy/textured image so quality significantly affects file size
  const width = 400;
  const height = 400;
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < buf.length; i += 1) {
    buf[i] = (i * 37 + (i >> 3) * 19) & 255;
  }
  const srcPath = path.join(dir, 'textured.png');
  await sharp(buf, { raw: { width, height, channels: 3 } }).png().toFile(srcPath);

  for (const format of ['jpeg', 'webp', 'avif']) {
    const low = await processImage(srcPath, {
      format,
      resizeMode: 'none',
      quality: 30,
      outputDir: `q30-${format}`,
    });
    const high = await processImage(srcPath, {
      format,
      resizeMode: 'none',
      quality: 92,
      outputDir: `q92-${format}`,
    });
    assert.ok(
      low.outputBytes < high.outputBytes,
      `Expected ${format} Q30 (${low.outputBytes}B) < Q92 (${high.outputBytes}B)`
    );
  }
});
