import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
    assert.deepEqual(parseTokenInput(`https://oauth.vk.com/blank.html#access_token=${tok}&expires_in=0&user_id=42`), { access_token: tok, user_id: 42, expires_in: 0 });
    assert.equal(parseTokenInput(`access_token=${tok}&user_id=1`).access_token, tok);
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
