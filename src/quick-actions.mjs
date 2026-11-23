import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const CLI_SCRIPT_PATH = path.join(PROJECT_ROOT, 'bin', 'imgresize.mjs');

const MANAGED_MARKER = '.mac-image-resizer-managed';
const ACTION_PREFIX = '画像変換: ';

export function getServicesDir() {
  if (process.env.MAC_IMAGE_RESIZER_SERVICES_DIR) {
    return path.resolve(process.env.MAC_IMAGE_RESIZER_SERVICES_DIR);
  }
  return path.join(os.homedir(), 'Library', 'Services');
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitizeWorkflowFileName(menuTitle) {
  // Replace path separators and colon (forbidden in macOS Finder filenames).
  return menuTitle.replace(/[/:\\]/g, '-').trim();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a robust shell command that works even when Finder's Quick Action environment
 * only has minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
 */
function buildShellCommand({ nodePath, cliPath, args }) {
  const quotedNode = shellQuote(nodePath);
  const quotedCli = shellQuote(cliPath);
  const quotedArgs = args.map((a) => shellQuote(a)).join(' ');

  return [
    'set -eu',
    `NODE_BIN=${quotedNode}`,
    'if [ ! -x "$NODE_BIN" ]; then',
    '  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME/.asdf/shims/node" "$HOME/.local/share/mise/shims/node"; do',
    '    if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi',
    '  done',
    'fi',
    'if [ ! -x "$NODE_BIN" ]; then',
    '  /usr/bin/osascript -e \'display alert "画像変換エラー" message "Node.js が見つかりませんでした。ターミナルで install.sh を再実行してください。" as critical\'',
    '  exit 1',
    'fi',
    `exec "$NODE_BIN" ${quotedCli} ${quotedArgs} -- "$@"`,
  ].join('\n');
}

function buildInfoPlist(menuTitle) {
  const escapedTitle = escapeXml(menuTitle);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSBackgroundColorName</key>
			<string>background</string>
			<key>NSIconName</key>
			<string>NSActionTemplate</string>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>${escapedTitle}</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSRequiredContext</key>
			<dict>
				<key>NSApplicationIdentifier</key>
				<string>com.apple.finder</string>
			</dict>
			<key>NSSendFileTypes</key>
			<array>
				<string>public.image</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
`;
}

function deterministicUuid(seed) {
  const hex = crypto.createHash('sha256').update(seed).digest('hex').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function buildDocumentWflow(menuTitle, commandString) {
  const actionUuid = deterministicUuid(`action:${menuTitle}`);
  const inputUuid = deterministicUuid(`input:${menuTitle}`);
  const outputUuid = deterministicUuid(`output:${menuTitle}`);
  const escapedCmd = escapeXml(commandString);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key>
	<string>523</string>
	<key>AMApplicationVersion</key>
	<string>2.10</string>
	<key>AMDocumentVersion</key>
	<string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Optional</key>
					<true/>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.path</string>
					</array>
				</dict>
				<key>AMActionVersion</key>
				<string>2.0.3</string>
				<key>AMApplication</key>
				<array>
					<string>Automator</string>
				</array>
				<key>AMParameterProperties</key>
				<dict>
					<key>COMMAND_STRING</key>
					<dict/>
					<key>CheckedForUserDefaultShell</key>
					<dict/>
					<key>inputMethod</key>
					<dict/>
					<key>shell</key>
					<dict/>
					<key>source</key>
					<dict/>
				</dict>
				<key>AMProvides</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.path</string>
					</array>
				</dict>
				<key>ActionBundlePath</key>
				<string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key>
				<string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key>
					<string>${escapedCmd}</string>
					<key>CheckedForUserDefaultShell</key>
					<true/>
					<key>inputMethod</key>
					<integer>1</integer>
					<key>shell</key>
					<string>/bin/zsh</string>
					<key>source</key>
					<string></string>
				</dict>
				<key>BundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key>
				<string>2.0.3</string>
				<key>CanShowSelectedItemsWhenRun</key>
				<false/>
				<key>CanShowWhenRun</key>
				<false/>
				<key>Category</key>
				<array>
					<string>AMCategoryUtilities</string>
				</array>
				<key>Class Name</key>
				<string>RunShellScriptAction</string>
				<key>InputUUID</key>
				<string>${inputUuid}</string>
				<key>Keywords</key>
				<array>
					<string>Shell</string>
					<string>Script</string>
					<string>Command</string>
					<string>Run</string>
					<string>Unix</string>
				</array>
				<key>OutputUUID</key>
				<string>${outputUuid}</string>
				<key>UUID</key>
				<string>${actionUuid}</string>
				<key>UnlocalizedApplications</key>
				<array>
					<string>Automator</string>
				</array>
				<key>arguments</key>
				<dict>
					<key>0</key>
					<dict>
						<key>default value</key>
						<integer>1</integer>
						<key>name</key>
						<string>inputMethod</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>0</string>
					</dict>
					<key>1</key>
					<dict>
						<key>default value</key>
						<string></string>
						<key>name</key>
						<string>source</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>1</string>
					</dict>
					<key>2</key>
					<dict>
						<key>default value</key>
						<false/>
						<key>name</key>
						<string>CheckedForUserDefaultShell</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>2</string>
					</dict>
					<key>3</key>
					<dict>
						<key>default value</key>
						<string></string>
						<key>name</key>
						<string>COMMAND_STRING</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>3</string>
					</dict>
					<key>4</key>
					<dict>
						<key>default value</key>
						<string>/bin/zsh</string>
						<key>name</key>
						<string>shell</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>4</string>
					</dict>
				</dict>
				<key>isViewVisible</key>
				<integer>1</integer>
			</dict>
		</dict>
	</array>
	<key>connectors</key>
	<dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>applicationBundleID</key>
		<string>com.apple.finder</string>
		<key>applicationBundleIDsByPath</key>
		<dict>
			<key>/System/Library/CoreServices/Finder.app</key>
			<string>com.apple.finder</string>
		</dict>
		<key>applicationPath</key>
		<string>/System/Library/CoreServices/Finder.app</string>
		<key>applicationPaths</key>
		<array>
			<string>/System/Library/CoreServices/Finder.app</string>
		</array>
		<key>backgroundColorName</key>
		<string>blackColor</string>
		<key>inputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject.image</string>
		<key>outputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>presentationMode</key>
		<integer>15</integer>
		<key>processesInput</key>
		<integer>0</integer>
		<key>serviceApplicationBundleID</key>
		<string>com.apple.finder</string>
		<key>serviceApplicationPath</key>
		<string>/System/Library/CoreServices/Finder.app</string>
		<key>serviceInputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject.image</string>
		<key>serviceOutputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key>
		<integer>0</integer>
		<key>systemImageName</key>
		<string>NSActionTemplate</string>
		<key>useAutomaticInputType</key>
		<integer>0</integer>
		<key>workflowTypeIdentifier</key>
		<string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>
`;
}

async function resolveNodeExecutable() {
  // Prefer stable system/homebrew paths if available, otherwise realpath of current process.execPath.
  const candidates = [process.execPath, '/opt/homebrew/bin/node', '/usr/local/bin/node'];
  for (const candidate of candidates) {
    try {
      const real = await fs.realpath(candidate);
      await fs.access(real, fs.constants.X_OK);
      // Avoid ephemeral fnm_multishells paths; realpath resolves them to ~/.local/share/fnm/...
      return real;
    } catch {
      continue;
    }
  }
  return process.execPath;
}

async function writeWorkflowBundle({ servicesDir, menuTitle, commandString, meta }) {
  const folderName = `${sanitizeWorkflowFileName(menuTitle)}.workflow`;
  const workflowDir = path.join(servicesDir, folderName);
  const contentsDir = path.join(workflowDir, 'Contents');

  await fs.mkdir(contentsDir, { recursive: true });
  await fs.writeFile(path.join(contentsDir, 'Info.plist'), buildInfoPlist(menuTitle), 'utf8');
  await fs.writeFile(
    path.join(contentsDir, 'document.wflow'),
    buildDocumentWflow(menuTitle, commandString),
    'utf8'
  );
  await fs.writeFile(
    path.join(contentsDir, MANAGED_MARKER),
    `${JSON.stringify({ managedBy: 'mac-image-resizer', ...meta, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8'
  );

  return { menuTitle, workflowDir };
}

export async function refreshMacServicesCache() {
  try {
    await execFileAsync('/System/Library/CoreServices/pbs', ['-update'], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronize Finder Quick Actions in ~/Library/Services with the current presets.
 * Removes stale workflows previously created by mac-image-resizer without touching user workflows.
 */
export async function syncQuickActions(options = {}) {
  const servicesDir = options.servicesDir ?? getServicesDir();
  const skipPbsUpdate = Boolean(options.skipPbsUpdate);
  const config = await loadConfig();
  const nodePath = await resolveNodeExecutable();

  await fs.mkdir(servicesDir, { recursive: true });

  const desiredEntries = [
    ...config.presets.map((preset) => ({
      menuTitle: `${ACTION_PREFIX}${preset.name}`,
      commandString: buildShellCommand({
        nodePath,
        cliPath: CLI_SCRIPT_PATH,
        args: ['convert', '--preset', preset.id, '--notify'],
      }),
      meta: { kind: 'preset', presetId: preset.id },
    })),
    {
      menuTitle: `${ACTION_PREFIX}詳細設定して変換`,
      commandString: buildShellCommand({
        nodePath,
        cliPath: CLI_SCRIPT_PATH,
        args: ['custom', '--notify'],
      }),
      meta: { kind: 'custom' },
    },
  ];

  const desiredFolderNames = new Set(
    desiredEntries.map((e) => `${sanitizeWorkflowFileName(e.menuTitle)}.workflow`)
  );

  // Remove stale managed workflows
  const removed = [];
  const existing = await fs.readdir(servicesDir, { withFileTypes: true });
  for (const dirent of existing) {
    if (!dirent.isDirectory() || !dirent.name.endsWith('.workflow')) continue;
    const workflowDir = path.join(servicesDir, dirent.name);
    const markerPath = path.join(workflowDir, 'Contents', MANAGED_MARKER);
    try {
      await fs.access(markerPath);
      if (!desiredFolderNames.has(dirent.name)) {
        await fs.rm(workflowDir, { recursive: true, force: true });
        removed.push(workflowDir);
      }
    } catch {
      // Not managed by mac-image-resizer; never touch.
    }
  }

  // Create or update desired workflows
  const installed = [];
  for (const entry of desiredEntries) {
    const res = await writeWorkflowBundle({ servicesDir, ...entry });
    installed.push(res);
  }

  const pbsUpdated = skipPbsUpdate ? false : await refreshMacServicesCache();
  return { servicesDir, nodePath, installed, removed, pbsUpdated };
}

/**
 * Remove all Quick Actions managed by mac-image-resizer.
 */
export async function uninstallQuickActions(options = {}) {
  const servicesDir = options.servicesDir ?? getServicesDir();
  const skipPbsUpdate = Boolean(options.skipPbsUpdate);
  const removed = [];

  try {
    const existing = await fs.readdir(servicesDir, { withFileTypes: true });
    for (const dirent of existing) {
      if (!dirent.isDirectory() || !dirent.name.endsWith('.workflow')) continue;
      const workflowDir = path.join(servicesDir, dirent.name);
      const markerPath = path.join(workflowDir, 'Contents', MANAGED_MARKER);
      try {
        await fs.access(markerPath);
        await fs.rm(workflowDir, { recursive: true, force: true });
        removed.push(workflowDir);
      } catch {
        // Not managed by mac-image-resizer.
      }
    }
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      throw err;
    }
  }

  const pbsUpdated = skipPbsUpdate ? false : await refreshMacServicesCache();
  return { servicesDir, removed, pbsUpdated };
}
