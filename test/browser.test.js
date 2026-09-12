import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import vm from 'node:vm';
import { runArchive } from '../src/archive.js';
import { importExport } from '../src/import.js';
import { startFakeVk, TOKEN } from './fake-vk.js';

const silent = { info() {}, warn() {}, debug() {}, error() {} };
const SCRIPT = fs.readFileSync(new URL('../browser-export.js', import.meta.url), 'utf8');

/**
 * Runs browser-export.js the way the browser console would, with window.vkApi.api
 * backed by the fake VK server (the page's own client is a thin wrapper over the
 * same methods), then imports the saved parts and archives offline.
 */
describe('browser export -> import -> run --offline', () => {
  let vk;
  let out;
  let saved;
  let summary;

  before(async () => {
    vk = await startFakeVk();
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-browser-test-'));
    saved = [];
    const api = async (method, params) => {
      const form = new URLSearchParams({ access_token: TOKEN });
      for (const [k, v] of Object.entries(params)) if (v !== undefined) form.set(k, String(v));
      const res = await fetch(`${vk.apiBase}${method}`, { method: 'POST', body: form });
      const body = await res.json();
      if (body.error) throw body.error;
      return body.response;
    };
    const sandbox = {
      window: { vkApi: { api }, __vkArchiveSave: (name, text) => saved.push({ name, text }) },
      console: { log() {}, error(...a) { throw new Error(a.join(' ')); } },
      navigator: { userAgent: 'TestBrowser/1.0' },
      setTimeout,
    };
    sandbox.globalThis = sandbox;
    // Small parts so the multi-file path is exercised.
    const script = SCRIPT.replace('chatsPerFile: 10,', 'chatsPerFile: 2,').replace('pauseMs: 350,', 'pauseMs: 0,');
    const result = await vm.runInNewContext(script, sandbox, { filename: 'browser-export.js' });
    assert.equal(result.conversations, 5);
    assert.equal(result.parts, 3);

    const files = saved.map((s) => {
      const f = path.join(out, s.name);
      fs.writeFileSync(f, s.text);
      return f;
    });
    // Import out of order on purpose; parts are sorted by number.
    const imported = importExport({ files: files.reverse(), out, log: silent });
    assert.equal(imported.done, true);
    summary = await runArchive({ api: null, out, log: silent, flags: { maxVideoQuality: 720 }, concurrency: 3 });
  });

  after(async () => {
    await vk.close();
    fs.rmSync(out, { recursive: true, force: true });
  });

  const dirOf = (peerId) => fs.readdirSync(out).find((d) => d.includes(`_${peerId}_`));

  it('exports every conversation including archived ones and records the inaccessible one', () => {
    const ids = summary.map((s) => s.peer_id).sort();
    assert.deepEqual(ids, [-100, 2, 4, 2000000001, 2000000002].sort());
    assert.match(summary.find((s) => s.peer_id === 2000000002).status, /^skipped/);
    assert.equal(summary.find((s) => s.peer_id === 2).message_count, 450);
    for (const s of summary) if (s.peer_id !== 2000000002) assert.equal(s.status, 'ok', `${s.peer_id}: ${s.status}`);
  });

  it('downloads media and videos from the cached video.get answers without any API', () => {
    const dir = path.join(out, dirOf(2));
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'media-index.json'), 'utf8'));
    const photos = Object.entries(index).filter(([k]) => k.startsWith('photo'));
    assert.ok(photos.length > 10, 'photos were downloaded');
    assert.ok(photos.some(([, r]) => r.status === 'ok'));
    assert.equal(index['video2_11']?.status, 'ok');
    assert.match(index['video2_11'].path, /720p\.mp4$/);
    assert.ok(fs.existsSync(path.join(dir, index['video2_11'].path)));
    const notDownloaded = fs.readFileSync(path.join(dir, 'videos-not-downloaded.txt'), 'utf8');
    assert.match(notDownloaded, /video2_13|youtube/i);
  });

  it('downloads media with the browser identity recorded in the export', () => {
    const meta = JSON.parse(fs.readFileSync(path.join(out, 'export-meta.json'), 'utf8'));
    assert.equal(meta.user_agent, 'TestBrowser/1.0');
    assert.equal(vk.state.lastFileUserAgent, 'TestBrowser/1.0');
  });

  it('computes the statistics at the start of an offline run, before media', () => {
    assert.ok(fs.existsSync(path.join(out, 'stats.html')));
    const stats = JSON.parse(fs.readFileSync(path.join(out, 'stats.json'), 'utf8'));
    assert.equal(stats.totals.chats, 4);
  });

  it('renders the same outputs as the API route and names people from the export', () => {
    const dir = path.join(out, dirOf(2));
    const html = fs.readFileSync(path.join(dir, 'messages.html'), 'utf8');
    assert.match(html, /<img/);
    assert.match(html, /class="who"[^>]*>Alice A</, 'author is rendered by name from the exported profiles');
    assert.ok(fs.existsSync(path.join(out, 'index.html')));
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(state.source, 'browser');
    assert.equal(state.history_complete, true);
  });
});
