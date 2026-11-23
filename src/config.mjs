import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const SUPPORTED_FORMATS = ['jpeg', 'png', 'webp', 'avif', 'tiff', 'heic'];
export const RESIZE_MODES = ['longEdge', 'dimensions', 'none'];

export const DEFAULT_PRESETS = [
  {
    id: 'sns',
    name: 'SNS用に縮小',
    format: 'jpeg',
    resizeMode: 'longEdge',
    maxLongEdge: 2560,
    width: null,
    height: null,
    withoutEnlargement: true,
    quality: 85,
    stripMetadata: true,
    convertToSrgb: true,
    outputDir: 'Resized',
  },
  {
    id: 'light',
    name: '軽量化',
    format: 'webp',
    resizeMode: 'longEdge',
    maxLongEdge: 1920,
    width: null,
    height: null,
    withoutEnlargement: true,
    quality: 80,
    stripMetadata: true,
    convertToSrgb: true,
    outputDir: 'Resized',
  },
  {
    id: 'high-comp',
    name: '高圧縮',
    format: 'avif',
    resizeMode: 'longEdge',
    maxLongEdge: 2560,
    width: null,
    height: null,
    withoutEnlargement: true,
    quality: 50,
    stripMetadata: true,
    convertToSrgb: true,
    outputDir: 'Resized',
  },
];

export const DEFAULT_CONFIG = {
  version: 1,
  defaults: {
    outputDir: 'Resized',
    concurrency: 3,
  },
  presets: DEFAULT_PRESETS,
};

export function getConfigDir() {
  if (process.env.MAC_IMAGE_RESIZER_CONFIG_DIR) {
    return path.resolve(process.env.MAC_IMAGE_RESIZER_CONFIG_DIR);
  }
  return path.join(os.homedir(), '.config', 'mac-image-resizer');
}

export function getConfigPath() {
  return path.join(getConfigDir(), 'presets.json');
}

export function getLogPath() {
  return path.join(getConfigDir(), 'last-run.log');
}

function parseOptionalPositiveInt(value, fieldName) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`${fieldName} must be an integer between 1 and 65535`);
  }
  return n;
}

export function slugifyPresetId(name) {
  const ascii = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii) {
    return ascii.slice(0, 48);
  }
  return `preset-${Date.now().toString(36)}`;
}

export function normalizePreset(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Preset must be an object');
  }

  const name = String(input.name ?? '').trim();
  if (!name) {
    throw new Error('Preset name is required');
  }

  const id = String(input.id ?? '').trim() || slugifyPresetId(name);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error('Preset id may only contain letters, numbers, hyphens, and underscores');
  }

  const rawFormat = String(input.format ?? 'jpeg').toLowerCase().trim();
  const format = rawFormat === 'jpg' ? 'jpeg' : rawFormat === 'tif' ? 'tiff' : rawFormat === 'heif' ? 'heic' : rawFormat;
  if (!SUPPORTED_FORMATS.includes(format)) {
    throw new Error(`Unsupported format: ${input.format}. Supported: ${SUPPORTED_FORMATS.join(', ')}`);
  }

  let resizeMode = String(input.resizeMode ?? 'longEdge').trim();
  if (!RESIZE_MODES.includes(resizeMode)) {
    throw new Error(`Unsupported resizeMode: ${resizeMode}. Supported: ${RESIZE_MODES.join(', ')}`);
  }

  const maxLongEdge = parseOptionalPositiveInt(input.maxLongEdge, 'maxLongEdge');
  const width = parseOptionalPositiveInt(input.width, 'width');
  const height = parseOptionalPositiveInt(input.height, 'height');

  if (resizeMode === 'longEdge' && !maxLongEdge) {
    resizeMode = 'none';
  }
  if (resizeMode === 'dimensions' && !width && !height) {
    resizeMode = 'none';
  }

  const qualityRaw = input.quality === undefined || input.quality === null ? 85 : Number(input.quality);
  if (!Number.isFinite(qualityRaw) || qualityRaw < 1 || qualityRaw > 100) {
    throw new Error('quality must be a number between 1 and 100');
  }
  const quality = Math.round(qualityRaw);

  const outputDir = String(input.outputDir ?? 'Resized').trim() || 'Resized';

  return {
    id,
    name,
    format,
    resizeMode,
    maxLongEdge: resizeMode === 'longEdge' ? maxLongEdge : null,
    width: resizeMode === 'dimensions' ? width : null,
    height: resizeMode === 'dimensions' ? height : null,
    withoutEnlargement: input.withoutEnlargement !== false,
    quality,
    stripMetadata: input.stripMetadata !== false,
    convertToSrgb: input.convertToSrgb !== false,
    outputDir,
  };
}

export async function loadConfig() {
  const configPath = getConfigPath();
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const presets = Array.isArray(parsed.presets)
      ? parsed.presets.map((p) => normalizePreset(p))
      : DEFAULT_PRESETS.map((p) => ({ ...p }));
    const concurrency = Math.max(
      1,
      Math.min(8, Number(parsed?.defaults?.concurrency) || DEFAULT_CONFIG.defaults.concurrency)
    );
    const outputDir = String(parsed?.defaults?.outputDir ?? DEFAULT_CONFIG.defaults.outputDir).trim() || 'Resized';
    return {
      version: 1,
      defaults: { outputDir, concurrency },
      presets,
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const fresh = structuredClone(DEFAULT_CONFIG);
      await saveConfig(fresh);
      return fresh;
    }
    throw err;
  }
}

export async function saveConfig(config) {
  const configDir = getConfigDir();
  const configPath = getConfigPath();
  await fs.mkdir(configDir, { recursive: true });
  const normalized = {
    version: 1,
    defaults: {
      outputDir: String(config?.defaults?.outputDir ?? 'Resized').trim() || 'Resized',
      concurrency: Math.max(1, Math.min(8, Number(config?.defaults?.concurrency) || 3)),
    },
    presets: (config?.presets ?? []).map((p) => normalizePreset(p)),
  };
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await fs.rename(tmpPath, configPath);
  return normalized;
}

export async function getPresetByIdOrName(identifier) {
  const config = await loadConfig();
  const target = String(identifier ?? '').trim();
  const found = config.presets.find((p) => p.id === target || p.name === target);
  return found ?? null;
}

export async function upsertPreset(presetInput) {
  const config = await loadConfig();
  const preset = normalizePreset(presetInput);
  const idx = config.presets.findIndex((p) => p.id === preset.id);
  if (idx >= 0) {
    config.presets[idx] = preset;
  } else {
    config.presets.push(preset);
  }
  await saveConfig(config);
  return preset;
}

export async function deletePreset(identifier) {
  const config = await loadConfig();
  const target = String(identifier ?? '').trim();
  const before = config.presets.length;
  config.presets = config.presets.filter((p) => p.id !== target && p.name !== target);
  if (config.presets.length === before) {
    return false;
  }
  await saveConfig(config);
  return true;
}

export async function resetConfig() {
  const fresh = structuredClone(DEFAULT_CONFIG);
  await saveConfig(fresh);
  return fresh;
}
