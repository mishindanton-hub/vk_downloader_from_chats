import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VkApi } from '../src/api.js';
import { describeInFlight, downloadAll, downloadFile } from '../src/download.js';
import { startFakeVk } from './fake-vk.js';
import { bestPhotoUrl, collectMedia, pickVideoFile } from '../src/attachments.js';
import { buildAuthUrl, parseTokenInput } from '../src/auth.js';
import { formatText } from '../src/render.js';
import { activity, readJson, sanitizeName, sleep, startHeartbeat } from '../src/util.js';

describe('auth helpers', () => {
  it('builds a Kate Mobile implicit-flow URL', () => {
    const u = new URL(buildAuthUrl());
    assert.equal(u.searchParams.get('client_id'), '2685278');
    assert.equal(u.searchParams.get('response_type'), 'token');
    assert.match(u.searchParams.get('scope'), /messages/);
    assert.equal(u.searchParams.get('redirect_uri'), 'https://oauth.vk.com/blank.html');
  });

  it('parses the redirect URL, a bare fragment and a bare token', () => {
    const tok = 'vk1.a.' + 'x'.repeat(80);
    assert.deepEqual(parseTokenInput(`https://oauth.vk.com/blank.html#access_token=${tok}&expires_in=0&user_id=42`), { access_token: tok, user_id: 42, expires_in: 0, domain: 'vk.com' });
    assert.equal(parseTokenInput(`https://oauth.vk.ru/blank.html#access_token=${tok}&expires_in=0&user_id=42`).domain, 'vk.ru', 'remembers that VK sent us to vk.ru');
    assert.equal(parseTokenInput(`access_token=${tok}&user_id=1`).access_token, tok);
    assert.equal(parseTokenInput(`access_token=${tok}&user_id=1`).domain, undefined);
    assert.equal(parseTokenInput(`  ${tok}\n`).access_token, tok);
    assert.throws(() => parseTokenInput('https://oauth.vk.com/blank.html#error=access_denied&error_description=User%20denied'), /access_denied/);
    assert.throws(() => parseTokenInput('hello'), /Could not recognise/);
  });
});

describe('sanitizeName', () => {
  it('strips path separators and reserved characters', () => {
    assert.equal(sanitizeName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
    assert.equal(sanitizeName('   '), 'untitled');
    assert.equal(sanitizeName('trailing dots...'), 'trailing dots');
    assert.equal(sanitizeName('x'.repeat(100), 10).length, 10);
  });
});

describe('attachment picking', () => {
  it('picks the largest photo size', () => {
    assert.equal(bestPhotoUrl({ sizes: [{ type: 's', width: 10, height: 10, url: 's' }, { type: 'w', width: 2000, height: 1000, url: 'w' }] }), 'w');
    assert.equal(bestPhotoUrl({ sizes: [{ type: 's', url: 's' }, { type: 'z', url: 'z' }] }), 'z', 'falls back to type ranking');
    assert.equal(bestPhotoUrl({ photo_604: 'a', photo_1280: 'b' }), 'b', 'legacy fields');
  });

  it('picks the best mp4 under the cap', () => {
    const files = { mp4_240: 'a', mp4_720: 'b', mp4_1080: 'c', hls: 'h' };
    assert.deepEqual(pickVideoFile({ files }, 2160), { url: 'c', quality: 1080 });
    assert.deepEqual(pickVideoFile({ files }, 720), { url: 'b', quality: 720 });
    assert.equal(pickVideoFile({ files: { hls: 'h' } }), null);
  });

  it('dedupes the same photo forwarded many times', () => {
    const photo = { type: 'photo', photo: { id: 1, owner_id: 1, sizes: [{ type: 'x', width: 1, height: 1, url: 'http://x/a.jpg' }] } };
    const messages = [
      { id: 1, date: 1, attachments: [photo] },
      { id: 2, date: 2, attachments: [], fwd_messages: [{ id: 0, date: 1, attachments: [photo], fwd_messages: [{ id: 0, date: 1, attachments: [photo] }] }] },
    ];
    const { jobs } = collectMedia(messages);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].key, 'photo1_1');
  });
});

describe('formatText', () => {
  it('escapes, linkifies and keeps newlines', () => {
    assert.equal(formatText('a<b\nhttp://x.y/z. [club5|Pub]'), 'a&lt;b<br><a href="http://x.y/z">http://x.y/z</a>. <a href="https://vk.com/club5">Pub</a>');
  });
});

describe('VkApi host fallback', () => {
  it('switches from api.vk.com to api.vk.ru when the first host is unreachable', async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      if (url.startsWith('https://api.vk.com/')) throw new Error('getaddrinfo ENOTFOUND api.vk.com');
      return { status: 200, text: async () => JSON.stringify({ response: [{ id: 1 }] }) };
    };
    const api = new VkApi({ token: 't', fetchImpl, minInterval: 0, log: { warn() {}, debug() {}, info() {} } });
    const res = await api.call('users.get');
    assert.deepEqual(res, [{ id: 1 }]);
    assert.ok(seen[0].startsWith('https://api.vk.com/method/users.get'));
    assert.ok(seen[1].startsWith('https://api.vk.ru/method/users.get'));
    const res2 = await api.call('users.get');
    assert.deepEqual(res2, [{ id: 1 }]);
    assert.equal(seen.length, 3, 'stays on the working host afterwards');
  });

  it('follows a cross-host redirect by re-POSTing to the new host', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url, method: init.method, redirect: init.redirect });
      if (url.startsWith('https://api.vk.com/')) {
        return { status: 301, headers: new Headers({ location: url.replace('api.vk.com', 'api.vk.ru') }), text: async () => '' };
      }
      return { status: 200, headers: new Headers(), text: async () => JSON.stringify({ response: [{ id: 7 }] }) };
    };
    const api = new VkApi({ token: 't', fetchImpl, minInterval: 0, log: { warn() {}, debug() {}, info() {} } });
    assert.deepEqual(await api.call('users.get'), [{ id: 7 }]);
    assert.equal(seen[0].redirect, 'manual');
    assert.equal(seen[1].url, 'https://api.vk.ru/method/users.get');
    assert.equal(seen[1].method, 'POST', 'the token must not be lost to a GET');
    await api.call('users.get');
    assert.equal(seen.length, 3, 'stays on the redirected host');
    assert.equal(api.baseUrl, 'https://api.vk.ru/method/');
  });

  it('starts on the configured domain and falls back to the other', async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      return { status: 200, headers: new Headers(), text: async () => JSON.stringify({ response: 1 }) };
    };
    const api = new VkApi({ token: 't', domain: 'vk.ru', fetchImpl, minInterval: 0 });
    await api.call('users.get');
    assert.equal(seen[0], 'https://api.vk.ru/method/users.get');
    assert.deepEqual(api.altBases, ['https://api.vk.com/method/']);
  });

  it('builds vk.ru auth URLs when asked', () => {
    const u = new URL(buildAuthUrl({ domain: 'vk.ru' }));
    assert.equal(u.host, 'oauth.vk.ru');
    assert.equal(u.searchParams.get('redirect_uri'), 'https://oauth.vk.ru/blank.html');
  });
});

describe('media naming', () => {
  it('renames files downloaded under the old name to the dated name without re-downloading', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-rename-'));
    fs.mkdirSync(path.join(dir, 'media/photos'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'media/photos/photo1_1.jpg'), 'x');
    fs.writeFileSync(path.join(dir, 'media-index.json'), JSON.stringify({ photo1_1: { status: 'ok', path: 'media/photos/photo1_1.jpg', kind: 'photo' } }));
    let fetched = 0;
    const fetchImpl = async () => { fetched += 1; throw new Error('should not fetch'); };
    const job = { key: 'photo1_1', kind: 'photo', url: 'http://x/a.jpg', rel: 'media/photos/2020-01-02_photo1_1.jpg', date: 1577923200 };
    const { index, stats } = await downloadAll([job], { dir, log: { warn() {} }, fetchImpl });
    assert.equal(fetched, 0);
    assert.equal(stats.skipped, 1);
    assert.equal(index.photo1_1.path, 'media/photos/2020-01-02_photo1_1.jpg');
    assert.ok(fs.existsSync(path.join(dir, 'media/photos/2020-01-02_photo1_1.jpg')));
    assert.ok(!fs.existsSync(path.join(dir, 'media/photos/photo1_1.jpg')));
    assert.equal(Math.floor(fs.statSync(path.join(dir, 'media/photos/2020-01-02_photo1_1.jpg')).mtimeMs / 1000), 1577923200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'media-index.json'), 'utf8')).photo1_1.path, 'media/photos/2020-01-02_photo1_1.jpg');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('heartbeat', () => {
  it('prints what it is doing, with bytes in flight, when the output has been quiet', async () => {
    const lines = [];
    const log = { info: (l) => lines.push(l), warn() {} };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-hb-'));
    // A fetch that trickles a 3-chunk body slowly, like a big video on a slow line.
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '30' }),
      body: (async function* () {
        for (let i = 0; i < 3; i += 1) {
          await sleep(60);
          yield Buffer.alloc(10, 1);
        }
      })(),
    });
    activity.lastOutput = Date.now() - 10000;
    const stop = startHeartbeat(log, { quietMs: 40, detail: describeInFlight });
    try {
      await downloadAll([{ key: 'video1_1', kind: 'video', url: 'http://x/v.mp4', rel: 'media/videos/2020-01-01_video1_1_720p.mp4', date: 1577836800 }], { dir, log, fetchImpl, label: 'Big chat' });
    } finally {
      stop();
      activity.clear();
    }
    assert.ok(lines.some((l) => /still working: downloading media for Big chat \[1 file in flight: 2020-01-01_video1_1_720p\.mp4 \d+ B\/30 B\]/.test(l)), lines.join('\n'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('resilience to damaged bookkeeping files', () => {
  it('readJson sets a corrupt file aside and returns the fallback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-json-'));
    const f = path.join(dir, 'state.json');
    fs.writeFileSync(f, '{"peer_id": 1, "fetch');
    const orig = console.warn;
    const warned = [];
    console.warn = (...a) => warned.push(a.join(' '));
    try {
      assert.deepEqual(readJson(f, { fresh: true }), { fresh: true });
    } finally {
      console.warn = orig;
    }
    assert.ok(!fs.existsSync(f), 'the broken file is moved away');
    assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('state.json.corrupt-')), 'and kept for inspection');
    assert.match(warned.join('\n'), /state\.json is not valid JSON/);
    assert.equal(readJson(path.join(dir, 'missing.json'), 7), 7);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('downloadAll adopts files already on disk when the index is gone, without fetching', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-adopt-'));
    fs.mkdirSync(path.join(dir, 'media/photos'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'media/photos/2020-01-02_photo1_1.jpg'), 'already here');
    let fetched = 0;
    const fetchImpl = async () => { fetched += 1; throw new Error('should not fetch'); };
    const job = { key: 'photo1_1', kind: 'photo', url: 'http://x/a.jpg', rel: 'media/photos/2020-01-02_photo1_1.jpg', date: 1577923200 };
    const { index, stats } = await downloadAll([job], { dir, log: { warn() {} }, fetchImpl });
    assert.equal(fetched, 0);
    assert.equal(stats.skipped, 1);
    assert.equal(index.photo1_1.status, 'ok');
    assert.equal(index.photo1_1.adopted, true);
    assert.equal(index.photo1_1.size, 12);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'media-index.json'), 'utf8')).photo1_1.status, 'ok', 'index rebuilt on disk');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('parallel range downloads', () => {
  const verify = (file) => {
    const buf = fs.readFileSync(file);
    assert.equal(buf.length, 3 * 1024 * 1024);
    for (let i = 0; i < buf.length; i += 4099) assert.equal(buf[i], (i * 7) & 0xff, `byte ${i}`);
  };

  it('fetches a big file as several ranges and reassembles it byte-exactly', async () => {
    const vk = await startFakeVk();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-ranges-'));
    try {
      const dest = path.join(dir, 'big.bin');
      let last = null;
      const size = await downloadFile(`${vk.base}/files/big_video.mp4`, dest, { parallel: 4, splitMin: 1024 * 1024, onBytes: (b, exp) => { last = [b, exp]; } });
      assert.equal(size, 3 * 1024 * 1024);
      verify(dest);
      assert.equal(vk.state.rangeRequests, 4, 'four range requests, one per slice');
      assert.deepEqual(last, [3 * 1024 * 1024, 3 * 1024 * 1024]);
    } finally {
      await vk.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to one stream when the server ignores Range', async () => {
    const vk = await startFakeVk();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-noranges-'));
    try {
      const dest = path.join(dir, 'big.bin');
      const size = await downloadFile(`${vk.base}/files/big_noranges.mp4`, dest, { parallel: 4, splitMin: 1024 * 1024 });
      assert.equal(size, 3 * 1024 * 1024);
      verify(dest);
    } finally {
      await vk.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves small files on the single-stream path', async () => {
    const vk = await startFakeVk();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-small-'));
    try {
      await downloadFile(`${vk.base}/files/big_small.mp4`, path.join(dir, 's.bin'), { parallel: 4 });
      assert.equal(vk.state.rangeRequests ?? 0, 0);
    } finally {
      await vk.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
