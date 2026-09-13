import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import vm from 'node:vm';
import { startGui } from '../src/gui.js';
import { sleep } from '../src/util.js';
import { startFakeVk, TOKEN } from './fake-vk.js';

const SCRIPT = fs.readFileSync(new URL('../browser-export.js', import.meta.url), 'utf8');
const silent = { info() {}, warn() {}, debug() {}, error() {} };

describe('gui: local page drives export watch, download and serves the archive', () => {
  let vk;
  let root;
  let gui;
  let base;

  before(async () => {
    vk = await startFakeVk();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-gui-'));
    const downloads = path.join(root, 'Downloads');
    const out = path.join(root, 'archive');
    fs.mkdirSync(downloads);
    process.env.VK_ARCHIVE_CONFIG = path.join(root, 'config.json'); // honoured lazily by config.js
    gui = await startGui({ out, downloads, open: false, flags: { maxVideoQuality: 720 }, log: silent });
    base = gui.address;

    // Nothing there yet, and nothing running: the page does not start watching,
    // importing or downloading until the user presses something.
    const s0 = await (await fetch(`${base}api/state`)).json();
    assert.equal(s0.chats, 0);
    assert.equal(s0.phase, 'idle');

    // The browser "saves" the export parts into Downloads while the GUI watches.
    const api = async (method, params) => {
      const form = new URLSearchParams({ access_token: TOKEN });
      for (const [k, v] of Object.entries(params)) if (v !== undefined) form.set(k, String(v));
      const res = await fetch(`${vk.apiBase}${method}`, { method: 'POST', body: form });
      const body = await res.json();
      if (body.error) throw body.error;
      return body.response;
    };
    const sandbox = { window: { vkApi: { api }, __vkArchiveSave: (name, text) => fs.writeFileSync(path.join(downloads, name), text) }, console: { log() {}, error() {} }, navigator: { userAgent: 'TestBrowser/1.0' }, setTimeout };
    sandbox.globalThis = sandbox;
    await vm.runInNewContext(SCRIPT.replace('chatsPerFile: 10,', 'chatsPerFile: 3,').replace('pauseMs: 350,', 'pauseMs: 0,'), sandbox);

    const post = (p) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const waitFor = async (ok, what) => {
      const deadline = Date.now() + 60000;
      for (;;) {
        const s = await (await fetch(`${base}api/state`)).json();
        if (ok(s)) return s;
        assert.ok(Date.now() < deadline, `timed out waiting for ${what} (phase ${s.phase})`);
        await sleep(300);
      }
    };

    // The files are sitting in Downloads: still nothing happens by itself.
    await sleep(600);
    const idle = await (await fetch(`${base}api/state`)).json();
    assert.equal(idle.phase, 'idle');
    assert.equal(idle.chats, 0);

    // Step 2, pressed by the user: import what the browser saved.
    await post('api/watch');
    const imported = await waitFor((s) => s.exportDone || s.phase === 'error', 'the export to be imported');
    assert.equal(imported.phase !== 'error', true);

    // Importing must not roll straight into downloading.
    await sleep(800);
    const held = await (await fetch(`${base}api/state`)).json();
    assert.equal(held.result, null);
    assert.ok(['idle', 'waiting'].includes(held.phase), `expected to be waiting for permission, was ${held.phase}`);

    // Step 3, pressed by the user.
    await post('api/download');
    await waitFor((s) => s.phase === 'done' || s.phase === 'error', 'the download to finish');
  });

  after(async () => {
    await gui.close();
    await vk.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finished the whole flow without any terminal interaction', async () => {
    const s = await (await fetch(`${base}api/state`)).json();
    assert.equal(s.phase, 'done', JSON.stringify(s.error));
    assert.equal(s.exportDone, true);
    assert.equal(s.parts, 2);
    assert.equal(s.chats, 5);
    assert.equal(s.result.chats, 4);
    assert.ok(s.result.media > 20);
    assert.ok(s.log.some((l) => /imported/.test(l)));
  });

  it('serves the page, the script and the finished archive', async () => {
    const page = await (await fetch(base)).text();
    assert.match(page, /Let your browser read the chats/);
    assert.match(page, /Speed settings/);
    assert.match(page, /Do not put the archive in iCloud Drive/);
    assert.match(await (await fetch(`${base}api/script`)).text(), /vk-archive-export\/1/);
    const index = await fetch(`${base}archive/index.html`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Alice A/);
    const stats = await fetch(`${base}archive/stats.html`);
    assert.equal(stats.status, 200);
  });

  it('serves media with Range requests so videos can seek', async () => {
    const outDir = gui.state.out;
    const dir = fs.readdirSync(outDir).find((d) => d.includes('_2_'));
    const idx = JSON.parse(fs.readFileSync(path.join(outDir, dir, 'media-index.json'), 'utf8'));
    const rel = idx['video2_11'].path;
    const url = `${base}archive/${encodeURI(`${dir}/${rel}`)}`;
    const full = await fetch(url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    const size = Number(full.headers.get('content-length'));
    const part = await fetch(url, { headers: { range: 'bytes=10-19' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 10-19/${size}`);
    assert.equal((await part.arrayBuffer()).byteLength, 10);
  });

  it('refuses paths outside the archive folder', async () => {
    const r = await fetch(`${base}archive/..%2F..%2Fconfig.json`);
    assert.ok(r.status === 403 || r.status === 404);
  });

  it('stores the speed settings and clamps them to sane values', async () => {
    const post = (body) => fetch(`${base}api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    let st = await post({ maxVideoQuality: 720, concurrency: 8, parallel: 6 });
    assert.deepEqual(st.settings, { maxVideoQuality: 720, concurrency: 8, parallel: 6, noVideo: false });
    st = await post({ concurrency: 999, parallel: 0, maxVideoQuality: 1, noVideo: true });
    assert.equal(st.settings.concurrency, 16, 'clamped to the maximum');
    assert.equal(st.settings.parallel, 1, 'clamped to the minimum');
    assert.equal(st.settings.maxVideoQuality, 144);
    assert.equal(st.settings.noVideo, true);
    const cfg = JSON.parse(fs.readFileSync(process.env.VK_ARCHIVE_CONFIG, 'utf8'));
    assert.equal(cfg.parallel, 1, 'remembered for next time');
    await post({ maxVideoQuality: 2160, concurrency: 4, parallel: 4, noVideo: false });
  });

  it('accepts new folder settings and rejects a missing Downloads folder', async () => {
    const bad = await fetch(`${base}api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ downloads: path.join(gui.state.out, 'nope') }) });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${base}api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ downloads: gui.state.downloads }) });
    assert.equal(ok.status, 200);
  });
});

/**
 * The folder in step 1 is the setting people get wrong, and getting it wrong
 * used to be silent: a typo or an unplugged drive became a new folder somewhere
 * else, and opening the page at all recreated a folder you had just deleted.
 */
describe('gui: the archive folder is only ever created on purpose', () => {
  let root;
  let gui;
  let base;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-gui-folder-'));
    fs.mkdirSync(path.join(root, 'Downloads'));
    process.env.VK_ARCHIVE_CONFIG = path.join(root, 'config.json');
    gui = await startGui({
      out: path.join(root, 'archive'),
      downloads: path.join(root, 'Downloads'),
      open: false,
      log: silent,
    });
    base = gui.address;
  });

  after(async () => {
    await gui.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

  it('does not create the folder just because the page was opened', async () => {
    assert.equal(fs.existsSync(path.join(root, 'archive')), false);
    const s = await (await fetch(`${base}api/state`)).json();
    assert.equal(s.outExists, false, 'and says so on the page');
  });

  it('creates it when the user presses "Use this folder"', async () => {
    const r = await post('api/settings', { out: path.join(root, 'on the ssd') });
    assert.equal(r.status, 200);
    assert.equal(fs.existsSync(path.join(root, 'on the ssd')), true);
    assert.equal((await r.json()).outExists, true);
  });

  it('refuses a path whose parent does not exist instead of inventing one', async () => {
    const r = await post('api/settings', { out: path.join(root, 'missing-drive', 'deep', 'archive') });
    assert.equal(r.status, 400);
    const { error } = await r.json();
    assert.match(error, /does not exist|not connected/);
    assert.equal(fs.existsSync(path.join(root, 'missing-drive')), false);
    const s = await (await fetch(`${base}api/state`)).json();
    assert.equal(s.out, path.join(root, 'on the ssd'), 'and keeps the folder that worked');
  });

  it('names the drive when an external disk is not plugged in', { skip: process.platform !== 'darwin' }, async () => {
    const r = await post('api/settings', { out: '/Volumes/Nope McNope/VK Archive' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /"Nope McNope" is not connected/);
  });
});
