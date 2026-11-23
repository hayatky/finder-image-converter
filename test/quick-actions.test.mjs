import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { upsertPreset, deletePreset } from '../src/config.mjs';
import { syncQuickActions, uninstallQuickActions } from '../src/quick-actions.mjs';

const execFileAsync = promisify(execFile);

test('syncs and uninstalls valid .workflow bundles without touching unrelated user workflows', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'imgresize-qa-'));
  const servicesDir = path.join(tempRoot, 'Services');
  const configDir = path.join(tempRoot, 'config');
  const prevConfigDir = process.env.MAC_IMAGE_RESIZER_CONFIG_DIR;
  process.env.MAC_IMAGE_RESIZER_CONFIG_DIR = configDir;

  t.after(async () => {
    if (prevConfigDir === undefined) {
      delete process.env.MAC_IMAGE_RESIZER_CONFIG_DIR;
    } else {
      process.env.MAC_IMAGE_RESIZER_CONFIG_DIR = prevConfigDir;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  // Create an unrelated user workflow that must NEVER be touched
  const userWorkflow = path.join(servicesDir, 'User Custom Action.workflow', 'Contents');
  await fs.mkdir(userWorkflow, { recursive: true });
  await fs.writeFile(path.join(userWorkflow, 'Info.plist'), '<plist/>', 'utf8');

  // 1. Initial sync (3 default presets + 1 custom dialog = 4 workflows)
  const sync1 = await syncQuickActions({ servicesDir, skipPbsUpdate: true });
  assert.equal(sync1.installed.length, 4);

  // Verify every generated Info.plist and document.wflow is valid XML plist via macOS plutil
  for (const item of sync1.installed) {
    const infoPlist = path.join(item.workflowDir, 'Contents', 'Info.plist');
    const docWflow = path.join(item.workflowDir, 'Contents', 'document.wflow');
    await execFileAsync('/usr/bin/plutil', ['-lint', infoPlist]);
    await execFileAsync('/usr/bin/plutil', ['-lint', docWflow]);
  }

  // 2. Add a custom preset and re-sync
  await upsertPreset({
    id: 'blog',
    name: 'ブログ用PNG',
    format: 'png',
    resizeMode: 'longEdge',
    maxLongEdge: 1280,
    quality: 90,
  });
  const sync2 = await syncQuickActions({ servicesDir, skipPbsUpdate: true });
  assert.equal(sync2.installed.length, 5);

  // 3. Delete the custom preset and re-sync -> stale workflow should be removed
  assert.equal(await deletePreset('blog'), true);
  const sync3 = await syncQuickActions({ servicesDir, skipPbsUpdate: true });
  assert.equal(sync3.installed.length, 4);
  assert.equal(sync3.removed.length, 1);

  // 4. Uninstall all managed workflows
  const uninstall = await uninstallQuickActions({ servicesDir, skipPbsUpdate: true });
  assert.equal(uninstall.removed.length, 4);

  // Unrelated user workflow must still exist
  const remaining = await fs.readdir(servicesDir);
  assert.deepEqual(remaining, ['User Custom Action.workflow']);
});
