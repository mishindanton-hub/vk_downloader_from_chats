import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, formatBytes, mapLimit, readJson, sleep, writeJson } from './util.js';

// 400 is deliberately not here: VK's video CDN answers 400 when the link's IP/browser binding
// does not match, which a later run with the right identity can fix.
const PERMANENT = new Set([401, 403, 404, 410]);

/**
 * Download a list of jobs into `dir`, recording outcome in `<dir>/media-index.json`.
 * - skips files already downloaded (index says ok AND file exists)
 * - skips permanently failed URLs (404 etc.) unless retryFailed is set
 * - writes to `.part` then renames, so partial files are never mistaken for complete ones
 * - retries transient failures with backoff
 */
export async function downloadAll(jobs, { dir, concurrency = 4, log, retryFailed = false, fetchImpl = globalThis.fetch, onProgress, userAgent }) {
  const indexPath = path.join(dir, 'media-index.json');
  const index = readJson(indexPath, {}) ?? {};
  const stats = { done: 0, skipped: 0, failed: 0, bytes: 0, total: jobs.length };
  let dirty = 0;
  const flush = () => {
    writeJson(indexPath, index);
    dirty = 0;
  };

  const pending = jobs.filter((job) => {
    const rec = index[job.key];
    if (rec?.status === 'ok' && fs.existsSync(path.join(dir, rec.path))) {
      stats.skipped += 1;
      return false;
    }
    if (rec?.status === 'failed' && rec.permanent && !retryFailed) {
      stats.skipped += 1;
      return false;
    }
    return true;
  });

  await mapLimit(pending, concurrency, async (job) => {
    const abs = path.join(dir, job.rel);
    try {
      const size = await downloadFile(job.url, abs, { fetchImpl, userAgent });
      index[job.key] = { status: 'ok', path: job.rel, kind: job.kind, size, url: job.url, title: job.title, msg_id: job.msg_id };
      stats.done += 1;
      stats.bytes += size;
    } catch (err) {
      const permanent = Boolean(err.permanent);
      index[job.key] = { status: 'failed', path: job.rel, kind: job.kind, url: job.url, error: err.message, permanent, msg_id: job.msg_id };
      stats.failed += 1;
      log.warn(`download failed ${job.key}: ${err.message}`);
    }
    dirty += 1;
    if (dirty >= 20) flush();
    onProgress?.(stats);
  });
  flush();
  return { index, stats };
}

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.permanent = PERMANENT.has(status);
  }
}

/** Stream a URL to disk with inactivity timeout and retries. Returns bytes written. */
export async function downloadFile(url, dest, { fetchImpl = globalThis.fetch, retries = 3, inactivityMs = 60000, userAgent } = {}) {
  ensureDir(path.dirname(dest));
  const part = `${dest}.part`;
  let attempt = 0;
  for (;;) {
    try {
      const size = await streamToFile(url, part, { fetchImpl, inactivityMs, userAgent });
      fs.renameSync(part, dest);
      return size;
    } catch (err) {
      try {
        fs.unlinkSync(part);
      } catch {
        /* nothing to clean */
      }
      if (err.permanent || attempt >= retries) throw err;
      attempt += 1;
      await sleep(Math.min(20000, 1500 * 2 ** attempt));
    }
  }
}

async function streamToFile(url, part, { fetchImpl, inactivityMs, userAgent }) {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), inactivityMs);
  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), inactivityMs);
  };
  const headers = {};
  if (userAgent) headers['user-agent'] = userAgent;
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers, redirect: 'follow' });
    if (!res.ok) throw new HttpError(res.status, url);
    const expected = Number(res.headers.get('content-length') ?? NaN);
    const out = fs.createWriteStream(part);
    let written = 0;
    try {
      for await (const chunk of res.body) {
        bump();
        written += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      }
    } finally {
      await new Promise((resolve, reject) => {
        out.end(() => resolve());
        out.on('error', reject);
      });
    }
    if (Number.isFinite(expected) && expected > 0 && written !== expected) {
      throw new Error(`truncated download: got ${formatBytes(written)} of ${formatBytes(expected)}`);
    }
    if (written === 0) throw new Error('empty response body');
    return written;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`stalled for ${inactivityMs / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
