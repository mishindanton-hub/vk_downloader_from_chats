import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { VkApi } from '../src/api.js';
import { rerender, runArchive } from '../src/archive.js';
import { startFakeVk, TOKEN } from './fake-vk.js';

const silent = { info() {}, warn() {}, debug() {}, error() {} };

describe('end-to-end archive against a fake VK', () => {
  let vk;
  let out;
  let api;
  let summary;

  before(async () => {
    vk = await startFakeVk();
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-archive-test-'));
    api = new VkApi({ token: TOKEN, baseUrl: vk.apiBase, minInterval: 0, log: silent });
    summary = await runArchive({ api, out, log: silent, flags: { maxVideoQuality: 720 }, concurrency: 3 });
  });

  after(async () => {
    await vk.close();
    fs.rmSync(out, { recursive: true, force: true });
  });

  const dirOf = (peerId) => fs.readdirSync(out).find((d) => d.includes(`_${peerId}_`));

  it('discovers regular and archived conversations, skips the inaccessible one', () => {
    const ids = summary.map((s) => s.peer_id).sort();
    assert.deepEqual(ids, [-100, 2, 4, 2000000001, 2000000002].sort());
    const kicked = summary.find((s) => s.peer_id === 2000000002);
    assert.match(kicked.status, /^skipped/);
    assert.equal(summary.find((s) => s.peer_id === 4).is_archived, true);
  });

  it('names directories safely from titles', () => {
    assert.ok(dirOf(2000000002).startsWith('chat_2000000002_Kicked _ from_ chat'));
    assert.equal(dirOf(2), 'user_2_Alice A');
    assert.equal(dirOf(-100), 'group_-100_Some Public');
  });

  it('pages through the full history and survives a "too many requests" error', () => {
    const dir = path.join(out, dirOf(2));
    const lines = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 450);
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'messages.json'), 'utf8'));
    assert.equal(data.message_count, 450);
    assert.equal(data.messages[0].id, 1, 'oldest first in messages.json');
    assert.equal(data.messages[449].id, 450);
    const histCalls = vk.state.calls.filter((c) => c.method === 'messages.getHistory' && c.params.peer_id === '2');
    assert.equal(histCalls.length, 3 + 1, '450 messages = 3 pages, plus the one retried call');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).history_complete, true);
  });

  it('downloads every attachment type once, largest size, into media/*', () => {
    const dir = path.join(out, dirOf(2));
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'media-index.json'), 'utf8'));
    const ok = Object.entries(index).filter(([, r]) => r.status === 'ok');
    const failed = Object.entries(index).filter(([, r]) => r.status === 'failed');

    // 45 photos every 10th message, minus the broken one (33 isn't a multiple of 10 so it's extra) -> 45 + flaky
    assert.equal(index['photo2_10'].path, 'media/photos/photo2_10.jpg');
    assert.ok(index['photo2_10'].url.endsWith('/files/photo2_10.jpg'), 'largest size chosen');
    assert.ok(fs.existsSync(path.join(dir, index['photo2_10'].path)));
    assert.equal(index['photo2_35'].status, 'ok', 'flaky download retried');
    assert.equal(index['photo2_33'].status, 'failed');
    assert.equal(index['photo2_33'].permanent, true);
    assert.equal(failed.length, 1);

    assert.equal(index['doc2_5'].path, 'media/docs/doc2_5_report.pdf');
    assert.equal(index['am2_7'].path, 'media/voice/am2_7.mp3');
    assert.ok(index['sticker9'].url.endsWith('sticker9_512.png'));
    assert.equal(index['video2_11'].path, 'media/videos/video2_11_720p.mp4', 'max quality respected');
    assert.equal(index['video2_11_thumb'].status, 'ok');
    assert.equal(index['photo5_1'].status, 'ok', 'photo inside forwarded message');
    assert.equal(index['photo-100_3'].status, 'ok', 'photo inside wall post');
    assert.equal(index['photo-100_4'].status, 'ok', 'photo inside repost history');
    assert.equal(index['gift25'].status, 'ok');
    assert.equal(index['graffiti2_27'].status, 'ok');
    assert.equal(index['audio2_29'].status, 'ok');
    assert.equal(index['audio2_31'], undefined, 'HLS audio is not downloaded');
    assert.equal(index['market-100_37'].status, 'ok');
    assert.ok(ok.length >= 57, `expected >= 57 ok files, got ${ok.length}`);
    for (const [, r] of ok) assert.ok(fs.statSync(path.join(dir, r.path)).size > 0);
    assert.equal(fs.readdirSync(path.join(dir, 'media/photos')).filter((f) => f.endsWith('.part')).length, 0);
  });

  it('records videos it cannot download for yt-dlp', () => {
    const dir = path.join(out, dirOf(2));
    const txt = fs.readFileSync(path.join(dir, 'videos-not-downloaded.txt'), 'utf8');
    assert.match(txt, /youtube\.com/);
    assert.match(txt, /vk\.com\/video2_15/);
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'messages.json'), 'utf8'));
    assert.equal(data.videos_not_downloaded.length, 2);
  });

  it('renders readable HTML and TXT with resolved names and escaped text', () => {
    const dir = path.join(out, dirOf(2));
    const html = fs.readFileSync(path.join(dir, 'messages.html'), 'utf8');
    assert.match(html, /Alice A/);
    assert.match(html, /User5 Resolved/, 'unknown forwarded author resolved through users.get');
    assert.match(html, /src="media\/photos\/photo2_10\.jpg"/);
    assert.match(html, /<video controls[^>]+src="media\/videos\/video2_11_720p\.mp4"/);
    assert.match(html, /<audio controls[^>]+src="media\/voice\/am2_7\.mp3"/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'text is escaped');
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /<a href="https:\/\/vk\.com\/id2">Alice<\/a>/, 'mentions linkified');
    assert.match(html, /<a href="https:\/\/example\.com\/page\?x=1">/, 'urls linkified');
    assert.match(html, /forwarded from a stranger/);
    assert.match(html, /the original/);
    assert.match(html, /Tea or coffee\?/);

    const txt = fs.readFileSync(path.join(dir, 'messages.txt'), 'utf8');
    assert.match(txt, /\] Me Self: msg 1\n/);
    assert.match(txt, /\[doc: report\.pdf -> media\/docs\/doc2_5_report\.pdf\]/);

    const chatHtml = fs.readFileSync(path.join(out, dirOf(2000000001), 'messages.html'), 'utf8');
    assert.match(chatHtml, /Me Self created the chat &quot;Test Chat&quot;/);
    assert.match(chatHtml, /Me Self invited Alice A/);
    assert.match(chatHtml, /Me Self left the chat/);
    assert.match(chatHtml, /User6 Resolved/);

    const index = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.match(index, /Alice A/);
    assert.match(index, /Test Chat/);
    assert.match(index, /skipped/);
  });

  it('is resumable: a second run makes no history calls and downloads nothing new', async () => {
    const callsBefore = vk.state.calls.length;
    const filesBefore = vk.state.filesServed;
    const api2 = new VkApi({ token: TOKEN, baseUrl: vk.apiBase, minInterval: 0, log: silent });
    await runArchive({ api: api2, out, log: silent, flags: { maxVideoQuality: 720 } });
    const newCalls = vk.state.calls.slice(callsBefore);
    assert.equal(newCalls.filter((c) => c.method === 'messages.getHistory' && c.params.peer_id !== '2000000002').length, 0);
    assert.equal(vk.state.filesServed, filesBefore, 'permanent 404 not retried, everything else cached');
  });

  it('--retry-failed retries permanently failed downloads', async () => {
    const filesBefore = vk.state.filesServed;
    const api3 = new VkApi({ token: TOKEN, baseUrl: vk.apiBase, minInterval: 0, log: silent });
    await runArchive({ api: api3, out, log: silent, flags: { maxVideoQuality: 720, retryFailed: true }, peerFilter: [2] });
    assert.equal(vk.state.filesServed, filesBefore + 1);
  });

  it('render command rebuilds outputs offline', () => {
    const htmlPath = path.join(out, dirOf(2), 'messages.html');
    fs.unlinkSync(htmlPath);
    const s = rerender({ out, log: silent });
    assert.ok(fs.existsSync(htmlPath));
    assert.equal(s.find((x) => x.peer_id === 2).message_count, 450);
  });

  it('rejects a bad token with a clear error', async () => {
    const bad = new VkApi({ token: 'wrong', baseUrl: vk.apiBase, minInterval: 0, log: silent });
    await assert.rejects(() => bad.call('users.get'), /\[5\] User authorization failed/);
  });
});
