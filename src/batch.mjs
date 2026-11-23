import fs from 'node:fs/promises';
import path from 'node:path';
import { processImage } from './processor.mjs';
import { getConfigDir, getLogPath } from './config.mjs';
import { formatBytes } from './file-manager.mjs';

/**
 * Process multiple image files with bounded concurrency.
 * Per-file failures never abort the remaining items.
 *
 * @param {string[]} filePaths
 * @param {object} options
 * @param {{ concurrency?: number, writeLog?: boolean }} [batchOptions]
 */
export async function processBatch(filePaths, options, batchOptions = {}) {
  const startedAt = Date.now();
  const uniquePaths = [];
  const seen = new Set();
  for (const rawPath of filePaths) {
    if (!rawPath) continue;
    const resolved = path.resolve(rawPath);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      uniquePaths.push(resolved);
    }
  }

  const concurrency = Math.max(1, Math.min(8, Number(batchOptions.concurrency) || 3));
  const results = new Array(uniquePaths.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= uniquePaths.length) {
        return;
      }
      const inputPath = uniquePaths[idx];
      try {
        const res = await processImage(inputPath, options);
        results[idx] = res;
      } catch (err) {
        results[idx] = {
          ok: false,
          inputPath,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  const workerCount = Math.min(concurrency, uniquePaths.length);
  const workers = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const totalInputBytes = succeeded.reduce((sum, r) => sum + (r.inputBytes || 0), 0);
  const totalOutputBytes = succeeded.reduce((sum, r) => sum + (r.outputBytes || 0), 0);
  const outputDirs = [...new Set(succeeded.map((r) => path.dirname(r.outputPath)))];
  const elapsedMs = Date.now() - startedAt;

  const summary = {
    total: uniquePaths.length,
    succeededCount: succeeded.length,
    failedCount: failed.length,
    totalInputBytes,
    totalOutputBytes,
    savedPercent:
      totalInputBytes > 0
        ? Math.round(((totalInputBytes - totalOutputBytes) / totalInputBytes) * 100)
        : 0,
    outputDirs,
    elapsedMs,
    results,
  };

  if (batchOptions.writeLog !== false) {
    await writeRunLog(summary, options).catch(() => {});
  }

  return summary;
}

async function writeRunLog(summary, options) {
  await fs.mkdir(getConfigDir(), { recursive: true });
  const lines = [
    `[${new Date().toISOString()}] mac-image-resizer run`,
    `Options: format=${options.format} resizeMode=${options.resizeMode} maxLongEdge=${options.maxLongEdge ?? '-'} width=${options.width ?? '-'} height=${options.height ?? '-'} quality=${options.quality} stripMetadata=${options.stripMetadata} convertToSrgb=${options.convertToSrgb} outputDir=${options.outputDir}`,
    `Summary: ${summary.succeededCount}/${summary.total} succeeded, ${summary.failedCount} failed, ${formatBytes(summary.totalInputBytes)} -> ${formatBytes(summary.totalOutputBytes)} (${summary.savedPercent}%), ${summary.elapsedMs}ms`,
    '',
  ];
  for (const r of summary.results) {
    if (r.ok) {
      lines.push(
        `OK   ${r.inputPath} -> ${r.outputPath} (${r.width}x${r.height}, ${formatBytes(r.inputBytes)} -> ${formatBytes(r.outputBytes)})`
      );
    } else {
      lines.push(`FAIL ${r.inputPath} :: ${r.error}`);
    }
  }
  await fs.writeFile(getLogPath(), `${lines.join('\n')}\n`, 'utf8');
}
