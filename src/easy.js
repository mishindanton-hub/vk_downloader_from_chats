import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { runArchive } from './archive.js';
import { loadConfig, saveConfig } from './config.js';
import { importExport } from './import.js';
import { ensureDir, readJson, sleep, writeJson } from './util.js';

const BROWSER_SCRIPT = fileURLToPath(new URL('../browser-export.js', import.meta.url));
const VK_URL = 'https://vk.ru/im';
const PART_RE = /^vk-export-\d+\.json$/;

/**
 * The one-button flow used by the launchers:
 *   1. ask where to save (remembered),
 *   2. open the VK messenger page and put browser-export.js on the clipboard,
 *   3. wait for the vk-export-NNN.json parts to appear in Downloads and import each,
 *   4. once the last part is in (or the user presses Enter), download all media and
 *      render, then open the result.
 * No token, no API calls from this machine except plain file downloads.
 */
export async function runEasy({ out: outFlag, downloads: dlFlag, log, flags = {}, concurrency = 4 }) {
  const cfg = loadConfig();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  say(`
==========================================
  VK Archive: save all your chats to disk
==========================================
`);

  // 1. where to save
  const defaultOut = outFlag ?? cfg.out ?? path.join(os.homedir(), 'VK Archive');
  const answerOut = (await ask(`Where should the archive be saved?\n  Press Enter for: ${defaultOut}\n  or drag a folder from Finder into this window and press Enter.\n> `)).trim();
  const out = expandPath(answerOut || defaultOut);
  ensureDir(out);
  const downloads = expandPath(dlFlag ?? cfg.downloads ?? path.join(os.homedir(), 'Downloads'));
  if (!fs.existsSync(downloads)) throw new Error(`Downloads folder not found: ${downloads}. Run with --downloads PATH.`);
  saveConfig({ ...cfg, out, downloads });
  say(`\nArchive folder:   ${out}\nDownloads folder: ${downloads}  (the browser saves the export files there)\n`);

  // 2. new export or continue?
  const existing = readJson(path.join(out, 'conversations.json'), null);
  const trackerPath = path.join(out, 'imported-parts.json');
  const imported = readJson(trackerPath, {}) ?? {};
  let mode = 'export';
  if (existing?.length) {
    const a = (await ask(`This folder already holds an archive with ${existing.length} chats.\n  [1] Continue: download any media still missing and rebuild the pages (default)\n  [2] Export the chats from the browser again (new messages, or first export did not finish)\n> `)).trim();
    mode = a === '2' ? 'export' : 'continue';
  }

  if (mode === 'export') {
    const script = fs.readFileSync(BROWSER_SCRIPT, 'utf8');
    const copied = copyToClipboard(script);
    say(`
Now the browser does the reading, using your normal VK login (no password is typed here).

  1. A browser tab with ${VK_URL} opens now. Log in there if you are not.
  2. Open the browser's JavaScript console ON THAT TAB:
       Chrome:  press  Cmd+Option+J   (Windows: Ctrl+Shift+J)
       Safari:  Safari > Settings > Advanced > tick "Show features for web developers",
                then press  Cmd+Option+C
       Firefox: press  Cmd+Option+K   (Windows: Ctrl+Shift+K)
  3. ${copied ? 'The script is already on your clipboard: click into the console, press Cmd+V (Windows: Ctrl+V)' : `Open the file\n       ${BROWSER_SCRIPT}\n     in a text editor, copy ALL of it, paste it into the console`}
     and press Enter.
     If Chrome answers "allow pasting": type  allow pasting  , press Enter, and paste again.
  4. Leave the tab open. It prints [vk-archive] lines and saves files named
     vk-export-001.json, vk-export-002.json, ... into your Downloads folder.
     If the browser asks whether to allow multiple downloads, say yes.

This window watches the Downloads folder and imports each file as it arrives.
When the last one is in, it downloads every photo, video, voice message and document
by itself. Press Enter here at any time to stop waiting and continue with what has
arrived so far. Ctrl+C quits (run again later; nothing is lost).
`);
    openInBrowser(VK_URL);

    let enterPressed = false;
    const startedAt = Date.now();
    // Ignore a stray Enter left over from the folder prompt.
    rl.on('line', () => { if (Date.now() - startedAt > 3000) enterPressed = true; });
    const sizes = new Map();
    let done = false;
    let lastNote = 0;
    let partsSeen = Object.keys(imported).length;
    while (!done && !enterPressed) {
      const names = fs.readdirSync(downloads).filter((n) => PART_RE.test(n)).sort();
      for (const name of names) {
        const file = path.join(downloads, name);
        const st = fs.statSync(file);
        const key = `${name}:${st.size}:${Math.floor(st.mtimeMs)}`;
        if (imported[key]) continue;
        // Wait until the size is stable, then check the file parses (still being written otherwise).
        if (sizes.get(name) !== st.size) { sizes.set(name, st.size); continue; }
        let data;
        try {
          data = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          continue;
        }
        if (data?.format !== 'vk-archive-export/1') {
          say(`  ${name} is not a VK Archive export file; ignoring it.`);
          imported[key] = { ignored: true };
          continue;
        }
        const res = importExport({ files: [file], out, log: quiet(log) });
        partsSeen += 1;
        imported[key] = { imported_at: new Date().toISOString(), chats: res.chats, part: data.part, done: Boolean(data.done) };
        writeJson(trackerPath, imported);
        say(`  + ${name}: ${res.chats} chats, ${res.messages} messages imported${data.done ? ' (last part)' : ''}`);
        if (data.done) done = true;
      }
      if (!done && Date.now() - lastNote > 30000) {
        say(`  ... waiting for export files in ${downloads} (${partsSeen} received so far). Press Enter to continue without waiting.`);
        lastNote = Date.now();
      }
      if (!done) await sleep(2000);
    }
    rl.removeAllListeners('line');
    if (!done && !readJson(path.join(out, 'conversations.json'), null)?.length) {
      say('\nNothing was imported. Run this again once the browser has saved at least one vk-export file.');
      rl.close();
      return 1;
    }
    if (!done) say('\nContinuing with the parts received so far. Run this again later to add the rest.');
  }

  rl.close();

  // 3. media + rendering, no API
  say(`\nDownloading media and building the pages in ${out} ...\n(This can take hours for a big account. You can close this window and run it again later; it continues where it stopped.)\n`);
  const summary = await runArchive({ api: null, out, log, flags, concurrency });
  const ok = summary.filter((s) => s.status === 'ok').length;
  const failed = summary.reduce((n, s) => n + (s.media_failed ?? 0), 0);
  const index = path.join(out, 'index.html');
  say(`\nDone: ${ok} chats archived${failed ? `, ${failed} media files could not be downloaded (VK no longer serves them)` : ''}.\nOpen ${index} in any browser.`);
  openInBrowser(index);
  return 0;
}

function say(text) {
  process.stdout.write(`${text}\n`);
}

function quiet(log) {
  return { ...log, info() {}, debug() {} };
}

/** Accept "~/x", a path dragged from Finder (spaces escaped with backslashes), or a quoted path. */
export function expandPath(p) {
  let s = String(p ?? '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  s = s.replace(/\\(.)/g, '$1');
  if (s === '~' || s.startsWith('~/')) s = path.join(os.homedir(), s.slice(1));
  return path.resolve(s);
}

function copyToClipboard(text) {
  const cmd = process.platform === 'darwin' ? ['pbcopy'] : process.platform === 'win32' ? ['clip'] : ['xclip', '-selection', 'clipboard'];
  try {
    const r = spawnSync(cmd[0], cmd.slice(1), { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    return r.status === 0;
  } catch {
    return false;
  }
}

function openInBrowser(target) {
  const cmd = process.platform === 'darwin' ? ['open', target] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', target] : ['xdg-open', target];
  try {
    spawnSync(cmd[0], cmd.slice(1), { stdio: 'ignore' });
  } catch {
    /* user opens it by hand */
  }
}
