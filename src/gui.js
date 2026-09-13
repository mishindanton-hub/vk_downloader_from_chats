import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runArchive } from './archive.js';
import { readAsset } from './assets.js';
import { loadConfig, saveConfig } from './config.js';
import { activity, ensureDir, formatBytes, makeLogger, readJson, startHeartbeat } from './util.js';
import { archivedChatCount, watchDownloads } from './watch.js';

const VK_URL = 'https://vk.ru/im';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
};

/**
 * The point-and-click interface: a tiny local web server plus one page.
 * The page shows the steps, copies the console script, watches the Downloads
 * folder, starts the media download, streams progress, and serves the finished
 * archive so it can be browsed at http://127.0.0.1:PORT/archive/.
 */
export async function startGui({ out: outFlag, downloads: dlFlag, port = 0, open = true, flags = {}, concurrency = 4, log: baseLog } = {}) {
  const cfg = loadConfig();
  const state = {
    phase: 'idle', // idle | waiting | pages | media | stats | done | error
    out: expand(outFlag ?? cfg.out ?? path.join(os.homedir(), 'VK Archive')),
    downloads: expand(dlFlag ?? cfg.downloads ?? path.join(os.homedir(), 'Downloads')),
    chats: 0,
    parts: 0,
    exportDone: false,
    progress: null, // the chat whose media is downloading: { index, total, title, media: {done,failed,skipped,total,bytes,complete} }
    reading: null, // the chat being read/prepared meanwhile: { index, total, title }
    speed: 0, // bytes per second over the last few seconds
    settings: {
      maxVideoQuality: Number(cfg.maxVideoQuality ?? flags.maxVideoQuality ?? 2160),
      concurrency: Number(cfg.concurrency ?? concurrency),
      parallel: Number(cfg.parallel ?? 4),
      noVideo: Boolean(cfg.noVideo ?? flags.noVideo),
    },
    result: null,
    error: null,
    started_at: Date.now(),
  };
  const clients = new Set();
  const lines = [];
  const push = (line) => {
    lines.push(line);
    if (lines.length > 400) lines.shift();
    broadcast({ type: 'log', line });
  };
  const broadcast = (event) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) {
      try {
        res.write(data);
      } catch {
        clients.delete(res);
      }
    }
  };
  const setState = (patch) => {
    Object.assign(state, patch);
    try {
      broadcast({ type: 'state', state: publicState() });
    } catch (err) {
      inner.warn(`could not publish state: ${err.message}`);
    }
  };
  const publicState = () => {
    let chats = 0;
    try {
      chats = archivedChatCount(state.out);
    } catch {
      /* counted as 0 until readable */
    }
    return { ...state, chats, activity: activity.text, lines: undefined };
  };

  // The service must outlive any single hiccup: a dropped browser socket, a bad file,
  // a rejected promise nobody awaited. Log it and keep serving.
  process.on('uncaughtException', (err) => {
    inner.error(`unexpected error (kept running): ${err?.stack ?? err}`);
    push(`✖ unexpected error: ${err?.message ?? err}`);
  });
  process.on('unhandledRejection', (err) => {
    inner.error(`unexpected error (kept running): ${err?.stack ?? err}`);
    push(`✖ unexpected error: ${err?.message ?? err}`);
  });

  const inner = baseLog ?? makeLogger(false);
  const log = {
    info: (...a) => { inner.info(...a); push(a.join(' ')); },
    warn: (...a) => { inner.warn(...a); push(`⚠ ${a.join(' ')}`); },
    debug: (...a) => inner.debug(...a),
    error: (...a) => { inner.error(...a); push(`✖ ${a.join(' ')}`); },
  };

  saveConfig({ ...cfg, out: state.out, downloads: state.downloads });
  ensureDir(state.out);

  // Bytes/second over a short window, so the page can show a real rate.
  let lastBytes = 0;
  let lastAt = Date.now();
  const noteBytes = (bytes) => {
    const now = Date.now();
    const dt = (now - lastAt) / 1000;
    if (dt >= 3) {
      const delta = bytes - lastBytes;
      state.speed = delta >= 0 && dt > 0 ? Math.round(delta / dt) : 0;
      lastBytes = bytes;
      lastAt = now;
    }
  };

  // --- background work -------------------------------------------------------
  let watching = false;
  let stopWatch = false;
  let running = false;

  async function watch() {
    if (watching) return;
    watching = true;
    stopWatch = false;
    setState({ phase: 'waiting' });
    try {
      const { done, parts } = await watchDownloads({
        downloads: state.downloads,
        out: state.out,
        log,
        shouldStop: () => stopWatch,
        onPart: (p) => setState({ parts: p.parts, exportDone: p.done }),
        onIdle: ({ parts }) => { if (state.parts !== parts) setState({ parts }); },
      });
      setState({ parts, exportDone: done });
      if (done && !running) await download();
    } catch (err) {
      log.error(err.message);
      setState({ phase: 'error', error: err.message });
    } finally {
      watching = false;
      if (state.phase === 'waiting') setState({ phase: 'idle' });
    }
  }

  async function download() {
    if (running) return;
    running = true;
    stopWatch = true;
    setState({ phase: 'pages', error: null, result: null, progress: null, reading: null, speed: 0 });
    lastBytes = 0;
    lastAt = Date.now();
    const stopHb = startHeartbeat(log);
    const wake = keepAwake(log);
    try {
      const summary = await runArchive({
        api: null,
        out: state.out,
        log,
        flags: { ...flags, retryFailed: true, maxVideoQuality: state.settings.maxVideoQuality, noVideo: state.settings.noVideo, parallel: state.settings.parallel },
        concurrency: state.settings.concurrency,
        hooks: {
          phase: (p) => setState({ phase: p }),
          // The loop reads the next chat while the previous one's files are still
          // downloading, so "reading" and "downloading" are two different chats.
          chat: (c) => setState({ reading: c, progress: state.progress ?? { ...c, media: null } }),
          media: (m) => {
            noteBytes(m.bytes ?? 0);
            setState({ progress: { index: m.index, total: m.total, title: m.title, media: m } });
          },
        },
      });
      const ok = summary.filter((s) => s.status === 'ok').length;
      const failed = summary.reduce((n, s) => n + (s.media_failed ?? 0), 0);
      const mediaOk = summary.reduce((n, s) => n + (s.media_ok ?? 0), 0);
      setState({ phase: 'done', result: { chats: ok, media: mediaOk, failed }, progress: null, reading: null });
    } catch (err) {
      log.error(err.message);
      setState({ phase: 'error', error: err.message });
    } finally {
      stopHb();
      wake();
      setState({ speed: 0 });
      running = false;
    }
  }

  // --- http ------------------------------------------------------------------
  const page = readAsset('gui.html');
  const script = readAsset('browser-export.js');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const body = async () => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return {};
      }
    };
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') return send(200, page, 'text/html; charset=utf-8');
      if (url.pathname === '/api/state') return send(200, { ...publicState(), log: lines.slice(-200), platform: process.platform, version: process.version });
      if (url.pathname === '/api/script') return send(200, script, 'text/plain; charset=utf-8');
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'state', state: publicState() })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        res.on('error', () => clients.delete(res));
        return undefined;
      }
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        const b = await body();
        const next = {};
        if (typeof b.out === 'string' && b.out.trim()) next.out = expand(b.out);
        if (typeof b.downloads === 'string' && b.downloads.trim()) next.downloads = expand(b.downloads);
        if (next.downloads && !fs.existsSync(next.downloads)) return send(400, { error: `Folder not found: ${next.downloads}` });
        if (next.out) ensureDir(next.out);
        const settings = { ...state.settings };
        if (b.maxVideoQuality !== undefined) settings.maxVideoQuality = clamp(Number(b.maxVideoQuality), 144, 2160, settings.maxVideoQuality);
        if (b.concurrency !== undefined) settings.concurrency = clamp(Number(b.concurrency), 1, 16, settings.concurrency);
        if (b.parallel !== undefined) settings.parallel = clamp(Number(b.parallel), 1, 8, settings.parallel);
        if (b.noVideo !== undefined) settings.noVideo = Boolean(b.noVideo);
        next.settings = settings;
        saveConfig({ ...loadConfig(), ...next, ...settings });
        setState(next);
        return send(200, publicState());
      }
      if (req.method === 'POST' && url.pathname === '/api/export') {
        copyToClipboard(script);
        openInBrowser(VK_URL);
        watch();
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/watch') {
        watch();
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/download') {
        if (!archivedChatCount(state.out)) return send(400, { error: 'Nothing imported yet. Export the chats from the browser first.' });
        download();
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/reveal') {
        revealInFileManager(state.out);
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/quit') {
        send(200, { ok: true });
        setTimeout(() => process.exit(0), 200);
        return undefined;
      }
      if (url.pathname.startsWith('/archive/')) return serveArchive(state.out, decodeURIComponent(url.pathname.slice('/archive/'.length)), req, res);
      return send(404, { error: 'not found' });
    } catch (err) {
      return send(500, { error: err.message });
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}/`;
  inner.info(`VK Archive is running at ${address}  (keep this running; close the window when you are done)`);
  if (open) openInBrowser(address);
  // Pick up export files that are already there / arrive while the page is open.
  if (!archivedChatCount(state.out) || !Object.values(readJson(path.join(state.out, 'imported-parts.json'), {}) ?? {}).some((t) => t.done)) watch();
  return { address, server, state, close: () => new Promise((r) => server.close(r)) };
}

/** Static files from the archive folder, with Range support so videos seek. */
function serveArchive(root, rel, req, res) {
  const abs = path.resolve(root, rel === '' ? 'index.html' : rel);
  if (!abs.startsWith(path.resolve(root))) {
    res.writeHead(403);
    return res.end();
  }
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  if (st.isDirectory()) {
    res.writeHead(302, { location: `/archive/${encodeURI(path.relative(root, path.join(abs, 'messages.html')))}` });
    return res.end();
  }
  const type = MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start >= st.size) {
      res.writeHead(416, { 'content-range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${st.size}`, 'accept-ranges': 'bytes' });
    return fs.createReadStream(abs, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes' });
  return fs.createReadStream(abs).pipe(res);
}

function clamp(n, lo, hi, fallback) {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
}

/**
 * Stop the computer from sleeping while a long download runs; a sleeping laptop
 * is the most common reason an overnight archive is not finished in the morning.
 * macOS: caffeinate. Windows/Linux: nothing to do here, we just tell the user.
 */
function keepAwake(log) {
  if (process.platform !== 'darwin') return () => {};
  try {
    const child = spawn('caffeinate', ['-i', '-m', '-w', String(process.pid)], { stdio: 'ignore', detached: false });
    child.on('error', () => {});
    log.debug?.('keeping the Mac awake while downloading (caffeinate)');
    return () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
  } catch {
    return () => {};
  }
}

function expand(p) {
  let s = String(p ?? '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  if (s === '~' || s.startsWith('~/')) s = path.join(os.homedir(), s.slice(1));
  return path.resolve(s);
}

function copyToClipboard(text) {
  const cmd = process.platform === 'darwin' ? ['pbcopy'] : process.platform === 'win32' ? ['clip'] : ['xclip', '-selection', 'clipboard'];
  try {
    return spawnSync(cmd[0], cmd.slice(1), { input: text, stdio: ['pipe', 'ignore', 'ignore'] }).status === 0;
  } catch {
    return false;
  }
}

export function openInBrowser(target) {
  const cmd = process.platform === 'darwin' ? ['open', target] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', target.replace(/&/g, '^&')] : ['xdg-open', target];
  try {
    spawn(cmd[0], cmd.slice(1), { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* user opens it by hand */
  }
}

function revealInFileManager(dir) {
  const cmd = process.platform === 'darwin' ? ['open', dir] : process.platform === 'win32' ? ['explorer', dir] : ['xdg-open', dir];
  try {
    spawn(cmd[0], cmd.slice(1), { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* ignore */
  }
}

export { formatBytes };
