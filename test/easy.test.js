import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import vm from 'node:vm';
import { expandPath } from '../src/easy.js';
import { startFakeVk, TOKEN } from './fake-vk.js';

const SCRIPT = fs.readFileSync(new URL('../browser-export.js', import.meta.url), 'utf8');
const BIN = new URL('../bin/vk-archive.js', import.meta.url).pathname;

describe('expandPath', () => {
  it('handles ~, Finder drag-and-drop escapes and quotes', () => {
    assert.equal(expandPath('~/VK Archive'), path.join(os.homedir(), 'VK Archive'));
    assert.equal(expandPath('/Users/me/My\\ Folder/x'), '/Users/me/My Folder/x');
    assert.equal(expandPath('"/tmp/a b"'), '/tmp/a b');
    assert.equal(expandPath('  '), process.cwd());
  });
});

describe('easy flow: export files in Downloads -> import -> offline archive', () => {
  let vk;
  let root;
  let downloads;
  let out;
  let output = '';
  let code;

  before(async () => {
    vk = await startFakeVk();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-easy-'));
    downloads = path.join(root, 'Downloads');
    out = path.join(root, 'archive');
    fs.mkdirSync(downloads);

    // Produce the parts exactly as the browser would.
    const api = async (method, params) => {
      const form = new URLSearchParams({ access_token: TOKEN });
      for (const [k, v] of Object.entries(params)) if (v !== undefined) form.set(k, String(v));
      const res = await fetch(`${vk.apiBase}${method}`, { method: 'POST', body: form });
      const body = await res.json();
      if (body.error) throw body.error;
      return body.response;
    };
    const sandbox = { window: { vkApi: { api }, __vkArchiveSave: (name, text) => fs.writeFileSync(path.join(downloads, name), text) }, console: { log() {}, error() {} }, setTimeout };
    sandbox.globalThis = sandbox;
    await vm.runInNewContext(SCRIPT.replace('chatsPerFile: 40,', 'chatsPerFile: 3,').replace('pauseMs: 350,', 'pauseMs: 0,'), sandbox);
    fs.writeFileSync(path.join(downloads, 'vk-export-999.json'), '{"not":"ours"}');
    assert.equal(fs.readdirSync(downloads).filter((n) => n.startsWith('vk-export-')).length, 3);

    // Drive the CLI like a person would: Enter to accept the proposed folder.
    code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, 'easy', '--out', out, '--downloads', downloads, '--max-video-quality', '720'], {
        env: { ...process.env, VK_ARCHIVE_CONFIG: path.join(root, 'config.json'), PATH: '/nonexistent' },
      });
      child.stdout.on('data', (d) => { output += d; });
      child.stderr.on('data', (d) => { output += d; });
      child.stdin.write('\n');
      child.on('exit', resolve);
    });
  });

  after(async () => {
    await vk.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finishes without a token and reports the result', () => {
    assert.equal(code, 0, output);
    assert.match(output, /\+ vk-export-001\.json: 3 chats/);
    assert.match(output, /\+ vk-export-002\.json: .*\(last part\)/);
    assert.match(output, /vk-export-999\.json is not a VK Archive export file/);
    assert.match(output, /Done: 4 chats archived/);
  });

  it('writes the archive where asked and remembers the folders', () => {
    assert.ok(fs.existsSync(path.join(out, 'index.html')));
    const dirs = fs.readdirSync(out).filter((d) => /^(user|chat|group)_/.test(d));
    assert.equal(dirs.length, 5);
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    assert.equal(cfg.out, out);
    assert.equal(cfg.downloads, downloads);
    const tracker = JSON.parse(fs.readFileSync(path.join(out, 'imported-parts.json'), 'utf8'));
    assert.equal(Object.values(tracker).filter((t) => !t.ignored).length, 2);
  });

  it('downloaded media offline', () => {
    const dir = fs.readdirSync(out).find((d) => d.includes('_2_'));
    const index = JSON.parse(fs.readFileSync(path.join(out, dir, 'media-index.json'), 'utf8'));
    assert.equal(index['video2_11']?.status, 'ok');
    assert.ok(Object.keys(index).some((k) => k.startsWith('photo')));
  });
});
