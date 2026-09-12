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
    process.env.VK_ARCHIVE_CONFIG = path.join(root, 'config.json');
    gui = await startGui({ out, downloads, open: false, flags: { maxVideoQuality: 720 }, log: silent });
    base = gui.address;

    // Nothing there yet: the page reports idle/waiting with zero chats.
    const s0 = await (await fetch(`${base}api/state`)).json();
    assert.equal(s0.chats, 0);
    assert.ok(['idle', 'waiting'].includes(s0.phase));

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

    // Wait for the watcher to import everything and the automatic download to finish.
    const deadline = Date.now() + 60000;
    for (;;) {
      const s = await (await fetch(`${base}api/state`)).json();
      if (s.phase === 'done' || s.phase === 'error') break;
      assert.ok(Date.now() < deadline, `timed out in phase ${s.phase}`);
      await sleep(300);
    }
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

  it('accepts new folder settings and rejects a missing Downloads folder', async () => {
    const bad = await fetch(`${base}api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ downloads: path.join(gui.state.out, 'nope') }) });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${base}api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ downloads: gui.state.downloads }) });
    assert.equal(ok.status, 200);
  });
});
