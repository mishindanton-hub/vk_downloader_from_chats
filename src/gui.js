import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runArchive } from './archive.js';
import { readAsset } from './assets.js';
import { loadConfig, saveConfig } from './config.js';
import { activity, ensureDir, formatBytes, makeLogger, startHeartbeat } from './util.js';
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
    totals: { files: 0, bytes: 0 }, // the whole run so far, across chats
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
    return {
      ...state,
      chats,
      outExists: fs.existsSync(state.out),
      outWarning: iCloudFolder(state.out)
        ? 'This folder is inside iCloud Drive. iCloud will upload the archive while it is being written and can remove the files again to save space — and getting them back needs free space you may not have. Choose a plain folder in your home folder, or an external drive.'
        : null,
      activity: activity.text,
      lines: undefined,
    };
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

  // Nothing is written until the user asks for it: opening the page must not
  // create a folder, and must not overwrite the remembered one either. A path
  // recreating itself the moment you delete it is exactly the surprise this
  // avoids.

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
  let doneFiles = 0; // files and bytes from the chats already finished in this run
  let doneBytes = 0;

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
      if (done) log.info('Export finished. Press "Start download" in step 3 when you are ready — nothing starts on its own.');
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
    setState({ phase: 'pages', error: null, result: null, progress: null, reading: null, speed: 0, totals: { files: 0, bytes: 0 } });
    lastBytes = 0;
    lastAt = Date.now();
    doneFiles = 0;
    doneBytes = 0;
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
          // Per chat from the archiver; the page also wants the run as a whole,
          // and the speed meter needs a number that only ever goes up (it used
          // to be handed each chat's bytes, which restart at zero every chat).
          media: (m) => {
            const s = m.media;
            const files = s.done + s.skipped + s.failed;
            const bytes = doneBytes + s.bytes;
            noteBytes(bytes);
            setState({
              progress: { index: m.index, total: m.total, title: m.title, media: s },
              totals: { files: doneFiles + files, bytes },
            });
            if (s.complete) {
              doneFiles += files;
              doneBytes += s.bytes;
            }
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
        if (next.out) {
          const bad = folderProblem(next.out);
          if (bad) return send(400, { error: bad });
          ensureDir(next.out);
        }
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
      if (req.method === 'POST' && url.pathname === '/api/choose') {
        const picked = await chooseFolder(state.out, log);
        if (picked.error) return send(400, picked);
        return send(200, picked);
      }
      if (req.method === 'POST' && url.pathname === '/api/export') {
        const bad = folderProblem(state.out);
        if (bad) return send(400, { error: bad });
        ensureDir(state.out);
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
        const bad = folderProblem(state.out);
        if (bad) return send(400, { error: bad });
        ensureDir(state.out);
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

/**
 * Whether a folder is inside iCloud Drive, whatever it looks like from the
 * outside: with Desktop & Documents syncing on, ~/Desktop and ~/Documents are
 * the iCloud copies, and the real path gives them away. iCloud uploads an
 * archive while it is still being written and then evicts files to save space,
 * which needs free space to undo — so a big archive there eats itself.
 */
function iCloudFolder(dir) {
  let real = dir;
  try {
    // Resolve the deepest part that exists; the folder itself may not yet.
    let probe = dir;
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    real = path.join(fs.realpathSync(probe), path.relative(probe, dir));
  } catch {
    /* fall back to the path as typed */
  }
  return real.includes('/Library/Mobile Documents/') || real.includes('/com~apple~CloudDocs/');
}

/**
 * Why a folder cannot be used, in words the user can act on, or null when it is
 * fine. The common one is an external drive that is not plugged in: creating
 * the path would silently make a folder inside /Volumes on the internal disk.
 */
function folderProblem(dir) {
  if (fs.existsSync(dir)) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      return `${dir} cannot be written to. Pick another folder, or fix its permissions.`;
    }
    return null;
  }
  const parent = path.dirname(dir);
  if (fs.existsSync(parent)) return null; // it will be created on demand
  const volumes = process.platform === 'darwin' ? '/Volumes' : null;
  if (volumes && dir.startsWith(`${volumes}/`)) {
    const drive = dir.split('/')[2];
    return `The drive "${drive}" is not connected. Plug it in (it should appear in Finder), then press this button again.`;
  }
  return `${parent} does not exist, so ${dir} cannot be created. Check the path, or use "Choose folder…".`;
}

/**
 * The system's own folder picker, opened by the program that will do the
 * writing, so what comes back is a real path this process can use. A text field
 * cannot do that: a typo, or a drive that is not mounted, silently becomes a
 * new folder somewhere else entirely.
 */
function chooseFolder(current, log) {
  const start = fs.existsSync(current) ? current : os.homedir();
  let cmd;
  if (process.platform === 'darwin') {
    // "tell me to activate" makes osascript itself frontmost, so its dialog lands
    // in front of the browser instead of behind it — the app has no Dock icon.
    cmd = ['osascript', '-e', 'tell me to activate',
      '-e', `POSIX path of (choose folder with prompt "Where should VK Archive save everything?" default location POSIX file ${JSON.stringify(start)})`];
  } else if (process.platform === 'win32') {
    cmd = ['powershell', '-NoProfile', '-STA', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms;' +
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog;' +
      '$d.Description = "Where should VK Archive save everything?";' +
      `$d.SelectedPath = ${JSON.stringify(start)};` +
      '$d.ShowNewFolderButton = $true;' +
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }'];
  } else {
    cmd = ['zenity', '--file-selection', '--directory', '--title=Where should VK Archive save everything?', `--filename=${start}/`];
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return resolve({ error: 'This computer has no folder chooser available; type the path instead.' });
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => resolve({ error: 'This computer has no folder chooser available; type the path instead.' }));
    return child.on('close', (code) => {
      const picked = out.trim();
      if (picked) return resolve({ path: path.resolve(picked) });
      // Cancelling is not a failure; anything else is worth reporting.
      if (/User canceled|cancel/i.test(err) || code === 1) return resolve({ cancelled: true });
      log?.debug?.(`folder chooser exited with ${code}: ${err.trim()}`);
      return resolve({ error: 'The folder chooser did not return a folder; type the path instead.' });
    });
  });
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
