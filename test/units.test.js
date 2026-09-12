import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VkApi } from '../src/api.js';
import { downloadAll } from '../src/download.js';
import { bestPhotoUrl, collectMedia, pickVideoFile } from '../src/attachments.js';
import { buildAuthUrl, parseTokenInput } from '../src/auth.js';
import { formatText } from '../src/render.js';
import { sanitizeName } from '../src/util.js';

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
