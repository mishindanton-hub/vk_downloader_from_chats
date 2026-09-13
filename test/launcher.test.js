/**
 * The macOS launcher is the only part of the app a non-technical user touches
 * first, and its failures used to be invisible (a background app's dialog can
 * open behind everything, or never at all). These tests run the real script
 * against a stub binary and stub `open`/`osascript`/`xattr`, and check that a
 * blocked program produces a visible explanation instead of a silent exit.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = path.join(root, 'VK Archive.app/Contents/MacOS/VK Archive');
const posix = process.platform !== 'win32';

/** Copy the launcher into a sandbox with a fake helper binary and fake tools. */
function sandbox(binScript) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-launcher-'));
  const macos = path.join(dir, 'VK Archive.app/Contents/MacOS');
  fs.mkdirSync(macos, { recursive: true });
  fs.copyFileSync(launcher, path.join(macos, 'VK Archive'));
  fs.writeFileSync(path.join(macos, 'vk-archive'), binScript, { mode: 0o755 });
  const stub = path.join(dir, 'stub');
  fs.mkdirSync(stub);
  for (const name of ['open', 'osascript', 'xattr']) {
    fs.writeFileSync(path.join(stub, name), `#!/bin/bash\necho "${name} $*" >>"$LAUNCH_LOG"\n`, { mode: 0o755 });
  }
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  return { dir, macos, stub, home };
}

function run(box) {
  const calls = path.join(box.dir, 'calls.txt');
  const res = spawnSync('bash', [path.join(box.macos, 'VK Archive')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${box.stub}:/usr/bin:/bin`,
      HOME: box.home,
      TMPDIR: box.dir,
      LAUNCH_LOG: calls,
    },
  });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return {
    status: res.status,
    calls: read(calls),
    log: read(path.join(box.home, 'Library/Logs/VK Archive.log')),
    page: read(path.join(box.dir, 'vk-archive-problem.html')),
  };
}

test('macOS launcher', { skip: posix ? false : 'POSIX shell only' }, async (t) => {
  await t.test('starts the bundled program when it works', () => {
    const box = sandbox('#!/bin/bash\nif [ "$1" = "--version" ]; then echo "vk-archive 9.9.9"; exit 0; fi\necho "ran: $*"\n');
    const out = run(box);
    assert.equal(out.status, 0);
    assert.match(out.log, /using bundled binary \(vk-archive 9\.9\.9\)/);
    assert.match(out.log, /ran: gui/);
    assert.equal(out.page, '');
  });

  await t.test('clears quarantine from its own files before trying', () => {
    const box = sandbox('#!/bin/bash\nexit 0\n');
    const out = run(box);
    assert.match(out.calls, /xattr -d com\.apple\.quarantine .*vk-archive/);
    assert.match(out.calls, /xattr -d com\.apple\.quarantine .*VK Archive/);
  });

  await t.test('explains a program macOS killed, instead of exiting silently', () => {
    const box = sandbox('#!/bin/bash\nkill -9 $$\n');
    const out = run(box);
    assert.equal(out.status, 1);
    assert.match(out.log, /exit 137/);
    assert.match(out.page, /Gatekeeper/);
    assert.match(out.page, /xattr -dr com\.apple\.quarantine/);
    assert.match(out.page, /macOS killed it/);
    assert.match(out.calls, /open .*vk-archive-problem\.html/);
    assert.match(out.calls, /osascript/);
  });
});
