import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { processImage } from '../src/processor.mjs';
import { processBatch } from '../src/batch.mjs';

async function sha256(filePath) {
  const data = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

test('protects source image, handles Japanese/special filenames, and avoids overwriting duplicates', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'imgresize-files-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const trickyName = "旅行の写真 2026 (東京's 夜景) 📷.png";
  const srcPath = path.join(dir, trickyName);
  await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 20, g: 40, b: 80 } },
  })
    .png()
    .toFile(srcPath);

  const hashBefore = await sha256(srcPath);

  const first = await processImage(srcPath, { format: 'jpeg', resizeMode: 'none', quality: 85 });
  const second = await processImage(srcPath, { format: 'jpeg', resizeMode: 'none', quality: 85 });
  const third = await processImage(srcPath, { format: 'jpeg', resizeMode: 'none', quality: 85 });

  assert.equal(path.basename(path.dirname(first.outputPath)), 'Resized');
  assert.equal(path.basename(first.outputPath), "旅行の写真 2026 (東京's 夜景) 📷.jpg");
  assert.equal(path.basename(second.outputPath), "旅行の写真 2026 (東京's 夜景) 📷 (1).jpg");
  assert.equal(path.basename(third.outputPath), "旅行の写真 2026 (東京's 夜景) 📷 (2).jpg");

  // Source image must remain bit-for-bit identical
  const hashAfter = await sha256(srcPath);
  assert.equal(hashAfter, hashBefore);
});

test('isolates per-file errors in batch processing and leaves no temp/empty files behind', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'imgresize-batch-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const good1 = path.join(dir, 'good1.png');
  const good2 = path.join(dir, 'good2.png');
  const broken = path.join(dir, 'broken.jpg');

  await sharp({ create: { width: 400, height: 300, channels: 3, background: '#336699' } }).png().toFile(good1);
  await sharp({ create: { width: 400, height: 300, channels: 3, background: '#996633' } }).png().toFile(good2);
  await fs.writeFile(broken, 'this is not a valid image file');

  const brokenBefore = await fs.readFile(broken, 'utf8');

  const summary = await processBatch(
    [good1, broken, good2],
    { format: 'webp', resizeMode: 'longEdge', maxLongEdge: 200, quality: 80, outputDir: 'Resized' },
    { concurrency: 2, writeLog: false }
  );

  assert.equal(summary.total, 3);
  assert.equal(summary.succeededCount, 2);
  assert.equal(summary.failedCount, 1);

  // Broken source file untouched
  assert.equal(await fs.readFile(broken, 'utf8'), brokenBefore);

  // Resized directory should only contain the 2 valid outputs (no leftover temp or empty broken.webp)
  const outFiles = (await fs.readdir(path.join(dir, 'Resized'))).sort();
  assert.deepEqual(outFiles, ['good1.webp', 'good2.webp']);
});
