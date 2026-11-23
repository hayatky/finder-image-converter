import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const FORMAT_EXTENSIONS = {
  jpeg: '.jpg',
  png: '.png',
  webp: '.webp',
  avif: '.avif',
  tiff: '.tiff',
  heic: '.heic',
};

export function extensionForFormat(format) {
  const key = String(format ?? '').toLowerCase();
  const ext = FORMAT_EXTENSIONS[key];
  if (!ext) {
    throw new Error(`Unsupported output format: ${format}`);
  }
  return ext;
}

/**
 * Resolve output directory relative to the input file's directory,
 * or as an absolute path (with ~ expansion).
 */
export function resolveOutputDir(inputFilePath, outputDirSetting = 'Resized') {
  const setting = String(outputDirSetting ?? 'Resized').trim() || 'Resized';
  if (setting === '~') {
    return os.homedir();
  }
  if (setting.startsWith('~/')) {
    return path.join(os.homedir(), setting.slice(2));
  }
  if (path.isAbsolute(setting)) {
    return path.resolve(setting);
  }
  return path.resolve(path.dirname(inputFilePath), setting);
}

/**
 * Safely allocate a unique output path without ever overwriting an existing file
 * or colliding with the input file. Creates a 0-byte reservation file atomically
 * using O_CREAT | O_EXCL ('wx') so concurrent workers cannot claim the same path.
 */
export async function reserveUniqueOutputPath(inputFilePath, outputDir, format) {
  await fs.mkdir(outputDir, { recursive: true });

  const resolvedInput = path.resolve(inputFilePath);
  const parsed = path.parse(resolvedInput);
  const baseName = parsed.name || 'image';
  const ext = extensionForFormat(format);

  for (let counter = 0; counter < 10000; counter += 1) {
    const candidateName = counter === 0 ? `${baseName}${ext}` : `${baseName} (${counter})${ext}`;
    const candidatePath = path.join(outputDir, candidateName);

    // Never allow writing to the same path as the source file.
    if (path.resolve(candidatePath) === resolvedInput) {
      continue;
    }

    try {
      const handle = await fs.open(candidatePath, 'wx');
      await handle.close();
      return candidatePath;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Could not find an available filename in ${outputDir} for ${baseName}${ext}`);
}

/**
 * Create a temporary file path in the target output directory (same filesystem for atomic rename).
 */
export function createTempPath(outputDir, ext) {
  const rand = crypto.randomBytes(6).toString('hex');
  return path.join(outputDir, `.imgresize-tmp-${process.pid}-${rand}${ext}`);
}

/**
 * Atomically commit a completed temporary file into a reserved destination path.
 * On failure, cleans up both temporary and empty reserved files without touching any pre-existing files.
 */
export async function commitTempFile(tempPath, reservedDestPath) {
  await fs.rename(tempPath, reservedDestPath);
}

export async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      // Best-effort cleanup
    }
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIdx]}`;
}
