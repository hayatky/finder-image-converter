import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Display a macOS notification banner using AppleScript (arguments passed safely via argv).
 */
export async function showNotification(title, subtitle, message) {
  const script = [
    'on run argv',
    '  set t to item 1 of argv',
    '  set s to item 2 of argv',
    '  set m to item 3 of argv',
    '  display notification m with title t subtitle s',
    'end run',
  ].join('\n');

  try {
    await execFileAsync('/usr/bin/osascript', ['-e', script, '--', title, subtitle, message], {
      timeout: 5000,
    });
  } catch {
    // Notifications are best-effort (e.g. headless or restricted environments).
  }
}

/**
 * Display a macOS alert dialog for partial or total failures, offering to open the log file.
 */
export async function showErrorAlert(title, message, logPath) {
  const script = [
    'on run argv',
    '  set t to item 1 of argv',
    '  set m to item 2 of argv',
    '  set chosen to button returned of (display alert t message m as warning buttons {"ログを開く", "OK"} default button "OK")',
    '  return chosen',
    'end run',
  ].join('\n');

  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script, '--', title, message], {
      timeout: 60000,
    });
    if (stdout.trim() === 'ログを開く' && logPath) {
      await execFileAsync('/usr/bin/open', [logPath]).catch(() => {});
    }
  } catch {
    // Ignore UI cancellation or headless errors.
  }
}

/**
 * Show a single-window native macOS Cocoa dialog (via JXA + AppKit, zero Xcode required)
 * for custom conversion settings and optional preset creation.
 *
 * Returns an options object or null if cancelled.
 */
export async function showCustomSettingsDialog(defaults = {}, fileCount = 1) {
  const initialJson = JSON.stringify({
    format: defaults.format ?? 'jpeg',
    resizeMode: defaults.resizeMode ?? 'longEdge',
    maxLongEdge: defaults.maxLongEdge ?? 2560,
    width: defaults.width ?? '',
    height: defaults.height ?? '',
    quality: defaults.quality ?? 85,
    outputDir: defaults.outputDir ?? 'Resized',
    stripMetadata: defaults.stripMetadata !== false,
    convertToSrgb: defaults.convertToSrgb !== false,
    withoutEnlargement: defaults.withoutEnlargement !== false,
    fileCount,
  });

  const jxaScript = `
ObjC.import('Cocoa');

function run(argv) {
  const init = JSON.parse(argv[0]);

  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  app.activateIgnoringOtherApps(true);

  const alert = $.NSAlert.alloc.init;
  alert.messageText = '画像変換の詳細設定';
  alert.informativeText = '選択された ' + init.fileCount + ' 件の画像を変換します（元画像は変更されません）。';
  alert.addButtonWithTitle('変換を実行');
  alert.addButtonWithTitle('キャンセル');

  const width = 420;
  const height = 340;
  const view = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, width, height));

  function makeLabel(text, x, y, w) {
    const label = $.NSTextField.labelWithString(text);
    label.frame = $.NSMakeRect(x, y, w, 20);
    label.alignment = $.NSTextAlignmentRight;
    view.addSubview(label);
    return label;
  }

  function makeField(value, placeholder, x, y, w) {
    const field = $.NSTextField.alloc.initWithFrame($.NSMakeRect(x, y, w, 24));
    field.stringValue = value === null || value === undefined ? '' : String(value);
    if (placeholder) field.placeholderString = placeholder;
    view.addSubview(field);
    return field;
  }

  function makePopup(items, selectedIndex, x, y, w) {
    const popup = $.NSPopUpButton.alloc.initWithFramePullsDown($.NSMakeRect(x, y, w, 26), false);
    for (const item of items) {
      popup.addItemWithTitle(item);
    }
    popup.selectItemAtIndex(Math.max(0, selectedIndex));
    view.addSubview(popup);
    return popup;
  }

  function makeCheckbox(title, checked, x, y, w) {
    const btn = $.NSButton.checkboxWithTitleTargetAction(title, null, null);
    btn.frame = $.NSMakeRect(x, y, w, 20);
    btn.state = checked ? $.NSControlStateValueOn : $.NSControlStateValueOff;
    view.addSubview(btn);
    return btn;
  }

  let y = height - 30;
  const labelW = 135;
  const fieldX = 145;
  const fieldW = 265;

  // Format
  const formatValues = ['jpeg', 'webp', 'avif', 'png', 'tiff', 'heic'];
  const formatLabels = ['JPEG (.jpg)', 'WebP (.webp)', 'AVIF (.avif)', 'PNG (.png)', 'TIFF (.tiff)', 'HEIC (.heic)'];
  makeLabel('出力形式:', 0, y + 2, labelW);
  const formatPopup = makePopup(formatLabels, Math.max(0, formatValues.indexOf(init.format)), fieldX, y, fieldW);

  y -= 34;
  // Resize mode
  const modeValues = ['longEdge', 'dimensions', 'none'];
  const modeLabels = ['長辺の最大サイズを指定', '幅・高さを個別に指定 (比率維持)', 'リサイズしない'];
  makeLabel('リサイズ方式:', 0, y + 2, labelW);
  const modePopup = makePopup(modeLabels, Math.max(0, modeValues.indexOf(init.resizeMode)), fieldX, y, fieldW);

  y -= 34;
  // Long edge
  makeLabel('長辺 (px):', 0, y + 2, labelW);
  const longEdgeField = makeField(init.maxLongEdge || 2560, '例: 2560', fieldX, y, 120);

  y -= 34;
  // Width x Height
  makeLabel('幅 × 高さ (px):', 0, y + 2, labelW);
  const widthField = makeField(init.width || '', '幅 (任意)', fieldX, y, 120);
  const xLabel = $.NSTextField.labelWithString('×');
  xLabel.frame = $.NSMakeRect(fieldX + 124, y + 2, 16, 20);
  xLabel.alignment = $.NSTextAlignmentCenter;
  view.addSubview(xLabel);
  const heightField = makeField(init.height || '', '高さ (任意)', fieldX + 145, y, 120);

  y -= 34;
  // Quality
  makeLabel('圧縮品質 (1-100):', 0, y + 2, labelW);
  const qualityField = makeField(init.quality || 85, '1〜100 (PNGは無視)', fieldX, y, 120);

  y -= 34;
  // Output folder
  makeLabel('保存先フォルダ:', 0, y + 2, labelW);
  const outputDirField = makeField(init.outputDir || 'Resized', 'Resized または絶対パス', fieldX, y, fieldW);

  y -= 32;
  // Checkboxes
  const stripCheck = makeCheckbox('メタデータを削除 (EXIF・GPS・XMP・IPTC)', init.stripMetadata, fieldX, y, fieldW);
  y -= 24;
  const srgbCheck = makeCheckbox('sRGB に色空間変換 (SNS共有向け)', init.convertToSrgb, fieldX, y, fieldW);
  y -= 24;
  const noEnlargeCheck = makeCheckbox('元画像より拡大しない', init.withoutEnlargement, fieldX, y, fieldW);

  y -= 36;
  // Optional save as preset
  makeLabel('プリセット保存名:', 0, y + 2, labelW);
  const savePresetField = makeField('', '空欄なら今回のみ適用 (入力するとメニューに追加)', fieldX, y, fieldW);

  alert.accessoryView = view;
  const response = alert.runModal;

  if (response !== $.NSAlertFirstButtonReturn) {
    return JSON.stringify({ cancelled: true });
  }

  const format = formatValues[formatPopup.indexOfSelectedItem] || 'jpeg';
  const resizeMode = modeValues[modePopup.indexOfSelectedItem] || 'longEdge';

  return JSON.stringify({
    cancelled: false,
    format,
    resizeMode,
    maxLongEdge: ObjC.unwrap(longEdgeField.stringValue).trim(),
    width: ObjC.unwrap(widthField.stringValue).trim(),
    height: ObjC.unwrap(heightField.stringValue).trim(),
    quality: ObjC.unwrap(qualityField.stringValue).trim(),
    outputDir: ObjC.unwrap(outputDirField.stringValue).trim() || 'Resized',
    stripMetadata: stripCheck.state === $.NSControlStateValueOn,
    convertToSrgb: srgbCheck.state === $.NSControlStateValueOn,
    withoutEnlargement: noEnlargeCheck.state === $.NSControlStateValueOn,
    savePresetName: ObjC.unwrap(savePresetField.stringValue).trim(),
  });
}
`;

  const { stdout } = await execFileAsync(
    '/usr/bin/osascript',
    ['-l', 'JavaScript', '-e', jxaScript, '--', initialJson],
    { maxBuffer: 1024 * 1024 }
  );

  const parsed = JSON.parse(stdout.trim());
  if (parsed.cancelled) {
    return null;
  }
  return parsed;
}
