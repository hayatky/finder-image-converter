#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  loadConfig,
  getPresetByIdOrName,
  upsertPreset,
  deletePreset,
  resetConfig,
  normalizePreset,
  getConfigPath,
  getLogPath,
} from '../src/config.mjs';
import { processBatch } from '../src/batch.mjs';
import { formatBytes } from '../src/file-manager.mjs';
import { showNotification, showErrorAlert, showCustomSettingsDialog } from '../src/macos-ui.mjs';
import { syncQuickActions, uninstallQuickActions } from '../src/quick-actions.mjs';

function printUsage() {
  console.log(`mac-image-resizer (imgresize)

Usage:
  imgresize convert [options] -- <file1> [file2 ...]
  imgresize custom [--notify] -- <file1> [file2 ...]
  imgresize preset list
  imgresize preset add --name <name> [options]
  imgresize preset remove <id-or-name>
  imgresize preset reset
  imgresize sync-actions
  imgresize uninstall-actions

Convert options:
  --preset <id|name>       Use a saved preset
  --format <fmt>           jpeg, png, webp, avif, tiff, heic
  --max-long-edge <px>     Resize so the longest side is at most <px>
  --width <px>             Max width (preserves aspect ratio)
  --height <px>            Max height (preserves aspect ratio)
  --no-resize              Do not resize
  --allow-enlarge          Allow upscaling smaller images
  --quality <1-100>        Compression quality (default: 85)
  --keep-metadata          Preserve EXIF/XMP/IPTC metadata (default: strip)
  --keep-color-profile     Keep original ICC profile instead of converting to sRGB
  --output-dir <dir>       Subfolder name or absolute path (default: Resized)
  --concurrency <1-8>      Parallel workers (default: 3)
  --notify                 Show macOS notification / error dialog

Config file: ${getConfigPath()}
`);
}

function buildOptionsFromFlags(values, base = {}) {
  const opts = {
    format: base.format ?? 'jpeg',
    resizeMode: base.resizeMode ?? 'longEdge',
    maxLongEdge: base.maxLongEdge ?? 2560,
    width: base.width ?? null,
    height: base.height ?? null,
    withoutEnlargement: base.withoutEnlargement ?? true,
    quality: base.quality ?? 85,
    stripMetadata: base.stripMetadata ?? true,
    convertToSrgb: base.convertToSrgb ?? true,
    outputDir: base.outputDir ?? 'Resized',
  };

  if (values.format) opts.format = values.format;
  if (values['no-resize']) {
    opts.resizeMode = 'none';
    opts.maxLongEdge = null;
    opts.width = null;
    opts.height = null;
  } else if (values.width || values.height) {
    opts.resizeMode = 'dimensions';
    opts.width = values.width ? Number(values.width) : null;
    opts.height = values.height ? Number(values.height) : null;
    opts.maxLongEdge = null;
  } else if (values['max-long-edge']) {
    opts.resizeMode = 'longEdge';
    opts.maxLongEdge = Number(values['max-long-edge']);
    opts.width = null;
    opts.height = null;
  }

  if (values['allow-enlarge']) opts.withoutEnlargement = false;
  if (values.quality !== undefined) opts.quality = Number(values.quality);
  if (values['keep-metadata']) opts.stripMetadata = false;
  if (values['keep-color-profile']) opts.convertToSrgb = false;
  if (values['output-dir']) opts.outputDir = values['output-dir'];

  return normalizePreset({ id: base.id || 'adhoc', name: base.name || 'Ad-hoc', ...opts });
}

async function reportBatchResult(summary, label, notify) {
  const sizeDelta =
    summary.totalInputBytes > 0
      ? `${formatBytes(summary.totalInputBytes)} → ${formatBytes(summary.totalOutputBytes)} (${summary.savedPercent >= 0 ? `-${summary.savedPercent}%` : `+${Math.abs(summary.savedPercent)}%`})`
      : '';

  if (summary.failedCount === 0) {
    const outDirLabel =
      summary.outputDirs.length === 1 ? path.basename(summary.outputDirs[0]) : `${summary.outputDirs.length}フォルダ`;
    const msg = `${summary.succeededCount}枚を変換 (${sizeDelta}) → ${outDirLabel}`;
    console.log(`[OK] ${label}: ${msg}`);
    if (notify) {
      await showNotification('画像変換が完了しました', label, msg);
    }
    return;
  }

  const failedItems = summary.results.filter((r) => !r.ok);
  const previewErrors = failedItems
    .slice(0, 5)
    .map((r) => `・${path.basename(r.inputPath)}: ${r.error}`)
    .join('\n');
  const moreLine = failedItems.length > 5 ? `\n…ほか ${failedItems.length - 5} 件` : '';
  const detailMsg = `成功: ${summary.succeededCount}枚 / 失敗: ${summary.failedCount}枚\n\n${previewErrors}${moreLine}`;

  console.error(`[PARTIAL/FAIL] ${label}\n${detailMsg}\nLog: ${getLogPath()}`);
  if (notify) {
    await showErrorAlert(`画像変換エラー (${label})`, detailMsg, getLogPath());
  }
}

async function handleConvert(rawArgs) {
  const { values, positionals } = parseArgs({
    args: rawArgs,
    allowPositionals: true,
    options: {
      preset: { type: 'string' },
      format: { type: 'string' },
      'max-long-edge': { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      'no-resize': { type: 'boolean', default: false },
      'allow-enlarge': { type: 'boolean', default: false },
      quality: { type: 'string' },
      'keep-metadata': { type: 'boolean', default: false },
      'keep-color-profile': { type: 'boolean', default: false },
      'output-dir': { type: 'string' },
      concurrency: { type: 'string' },
      notify: { type: 'boolean', default: false },
    },
  });

  if (positionals.length === 0) {
    const msg = '変換する画像ファイルが指定されていません。';
    console.error(msg);
    if (values.notify) {
      await showErrorAlert('画像変換エラー', msg, null);
    }
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig();
  let basePreset = { outputDir: config.defaults.outputDir };
  let label = 'カスタム変換';

  if (values.preset) {
    const found = await getPresetByIdOrName(values.preset);
    if (!found) {
      const msg = `プリセット "${values.preset}" が見つかりません。`;
      console.error(msg);
      if (values.notify) {
        await showErrorAlert('画像変換エラー', msg, null);
      }
      process.exitCode = 1;
      return;
    }
    basePreset = found;
    label = found.name;
  }

  const options = buildOptionsFromFlags(values, basePreset);
  const concurrency = values.concurrency ? Number(values.concurrency) : config.defaults.concurrency;
  const summary = await processBatch(positionals, options, { concurrency });
  await reportBatchResult(summary, label, values.notify);

  if (summary.failedCount > 0 && summary.succeededCount === 0) {
    process.exitCode = 1;
  }
}

async function handleCustom(rawArgs) {
  const { values, positionals } = parseArgs({
    args: rawArgs,
    allowPositionals: true,
    options: {
      notify: { type: 'boolean', default: false },
      concurrency: { type: 'string' },
    },
  });

  if (positionals.length === 0) {
    const msg = '変換する画像ファイルが指定されていません。';
    console.error(msg);
    if (values.notify) {
      await showErrorAlert('画像変換エラー', msg, null);
    }
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig();
  const defaultPreset = config.presets[0] ?? {};
  const dialogResult = await showCustomSettingsDialog(defaultPreset, positionals.length);
  if (!dialogResult) {
    // User cancelled
    return;
  }

  let normalized;
  try {
    normalized = normalizePreset({
      id: dialogResult.savePresetName ? undefined : 'custom',
      name: dialogResult.savePresetName || '詳細設定',
      format: dialogResult.format,
      resizeMode: dialogResult.resizeMode,
      maxLongEdge: dialogResult.maxLongEdge,
      width: dialogResult.width,
      height: dialogResult.height,
      withoutEnlargement: dialogResult.withoutEnlargement,
      quality: dialogResult.quality,
      stripMetadata: dialogResult.stripMetadata,
      convertToSrgb: dialogResult.convertToSrgb,
      outputDir: dialogResult.outputDir,
    });
  } catch (err) {
    const msg = `入力値が不正です: ${err.message}`;
    console.error(msg);
    if (values.notify) {
      await showErrorAlert('画像変換エラー', msg, null);
    }
    process.exitCode = 1;
    return;
  }

  if (dialogResult.savePresetName) {
    await upsertPreset(normalized);
    await syncQuickActions();
  }

  const concurrency = values.concurrency ? Number(values.concurrency) : config.defaults.concurrency;
  const summary = await processBatch(positionals, normalized, { concurrency });
  const label = dialogResult.savePresetName ? `${normalized.name} (プリセット保存済)` : '詳細設定';
  await reportBatchResult(summary, label, values.notify);

  if (summary.failedCount > 0 && summary.succeededCount === 0) {
    process.exitCode = 1;
  }
}

async function handlePreset(rawArgs) {
  const sub = rawArgs[0];
  const rest = rawArgs.slice(1);

  if (sub === 'list' || !sub) {
    const config = await loadConfig();
    console.log(`Config: ${getConfigPath()}\n`);
    for (const p of config.presets) {
      const resizeDesc =
        p.resizeMode === 'none'
          ? 'リサイズなし'
          : p.resizeMode === 'longEdge'
            ? `長辺 ${p.maxLongEdge}px`
            : `${p.width ?? '自動'}×${p.height ?? '自動'}px`;
      const metaDesc = p.stripMetadata ? 'メタデータ削除' : 'メタデータ保持';
      const colorDesc = p.convertToSrgb ? 'sRGB' : 'ICC維持';
      console.log(
        `- [${p.id}] ${p.name}: ${p.format.toUpperCase()} / ${resizeDesc} / Q${p.quality} / ${metaDesc} / ${colorDesc} / 出力先: ${p.outputDir}`
      );
    }
    return;
  }

  if (sub === 'add') {
    const { values } = parseArgs({
      args: rest,
      allowPositionals: false,
      options: {
        id: { type: 'string' },
        name: { type: 'string' },
        format: { type: 'string', default: 'jpeg' },
        'max-long-edge': { type: 'string' },
        width: { type: 'string' },
        height: { type: 'string' },
        'no-resize': { type: 'boolean', default: false },
        'allow-enlarge': { type: 'boolean', default: false },
        quality: { type: 'string', default: '85' },
        'keep-metadata': { type: 'boolean', default: false },
        'keep-color-profile': { type: 'boolean', default: false },
        'output-dir': { type: 'string', default: 'Resized' },
        'no-sync': { type: 'boolean', default: false },
      },
    });

    if (!values.name) {
      throw new Error('--name is required');
    }
    const presetOptions = buildOptionsFromFlags(values, {
      id: values.id,
      name: values.name,
      maxLongEdge: values['max-long-edge'] ? Number(values['max-long-edge']) : 2560,
    });
    const saved = await upsertPreset({ ...presetOptions, id: values.id || undefined, name: values.name });
    console.log(`Saved preset: [${saved.id}] ${saved.name}`);
    if (!values['no-sync']) {
      const sync = await syncQuickActions();
      console.log(`Synced ${sync.installed.length} Quick Actions in ${sync.servicesDir}`);
    }
    return;
  }

  if (sub === 'remove' || sub === 'delete') {
    const target = rest[0];
    if (!target) {
      throw new Error('Specify a preset id or name to remove');
    }
    const deleted = await deletePreset(target);
    if (!deleted) {
      throw new Error(`Preset not found: ${target}`);
    }
    console.log(`Removed preset: ${target}`);
    const sync = await syncQuickActions();
    console.log(`Synced ${sync.installed.length} Quick Actions in ${sync.servicesDir}`);
    return;
  }

  if (sub === 'reset') {
    await resetConfig();
    const sync = await syncQuickActions();
    console.log(`Reset presets to defaults and synced ${sync.installed.length} Quick Actions.`);
    return;
  }

  throw new Error(`Unknown preset subcommand: ${sub}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === '-h' || command === '--help' || command === 'help') {
    printUsage();
    return;
  }

  if (command === 'convert') {
    await handleConvert(rest);
  } else if (command === 'custom') {
    await handleCustom(rest);
  } else if (command === 'preset') {
    await handlePreset(rest);
  } else if (command === 'sync-actions') {
    const res = await syncQuickActions();
    console.log(`Installed/updated ${res.installed.length} Finder Quick Actions in ${res.servicesDir}:`);
    for (const item of res.installed) {
      console.log(`  - ${item.menuTitle}`);
    }
    if (res.removed.length > 0) {
      console.log(`Removed ${res.removed.length} stale Quick Actions.`);
    }
  } else if (command === 'uninstall-actions') {
    const res = await uninstallQuickActions();
    console.log(`Removed ${res.removed.length} Finder Quick Actions from ${res.servicesDir}.`);
  } else {
    console.error(`Unknown command: ${command}\n`);
    printUsage();
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
