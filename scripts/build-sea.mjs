#!/usr/bin/env node
/**
 * Build a standalone executable (Node "single executable application"):
 *   node scripts/build-sea.mjs [--out dist]
 *
 * Steps: bundle the CLI to one CommonJS file with esbuild, write the SEA config
 * with the two assets the tool needs at runtime (browser-export.js, src/gui.html),
 * generate the blob, copy the running node binary, inject the blob with postject,
 * and on macOS re-sign ad hoc. The result is dist/<name> (or <name>.exe).
 *
 * Runs on the platform it targets; the GitHub workflow runs it on macOS,
 * Windows and Linux runners.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'dist');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const exeName = isWin ? 'VK Archive.exe' : 'vk-archive';
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) throw new Error(`Node 20+ is required to build a single executable (have ${process.version})`);

fs.mkdirSync(outDir, { recursive: true });
const bundle = path.join(outDir, 'bundle.cjs');
const blob = path.join(outDir, 'sea.blob');
const exe = path.join(outDir, exeName);

// 1. bundle
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const esbuild = await import('esbuild');
await esbuild.build({
  entryPoints: [path.join(root, 'bin/vk-archive.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: `node${major}`,
  outfile: bundle,
  logLevel: 'warning',
  define: { __VK_ARCHIVE_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: `// VK Archive ${pkg.version} single-executable bundle` },
});

// 2. sea config + blob
const seaConfig = {
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  assets: {
    'browser-export.js': path.join(root, 'browser-export.js'),
    'gui.html': path.join(root, 'src/gui.html'),
  },
};
const cfgPath = path.join(outDir, 'sea-config.json');
fs.writeFileSync(cfgPath, JSON.stringify(seaConfig, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', cfgPath], { stdio: 'inherit' });

// 3. copy node, strip signature (mac), inject, sign
fs.copyFileSync(process.execPath, exe);
fs.chmodSync(exe, 0o755);
if (isMac) spawnSync('codesign', ['--remove-signature', exe], { stdio: 'inherit' });
const postject = path.join(root, 'node_modules/postject/dist/cli.js');
const args = [postject, exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (isMac) args.push('--macho-segment-name', 'NODE_SEA');
execFileSync(process.execPath, args, { stdio: 'inherit' });
if (isMac) spawnSync('codesign', ['--sign', '-', exe], { stdio: 'inherit' });

for (const f of [bundle, blob, cfgPath]) fs.rmSync(f, { force: true });
console.log(`built ${exe} (${(fs.statSync(exe).size / 1048576).toFixed(0)} MB)`);
