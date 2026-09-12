import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// In the repository this file lives in src/; in the single-executable bundle
// import.meta.url is undefined and the assets come from the SEA blob instead.
const ROOT = (() => {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return process.cwd();
  }
})();

function nodeRequire() {
  // eslint-disable-next-line no-undef
  if (typeof require === 'function') return require;
  return createRequire(import.meta.url);
}

/**
 * Files the tool ships with (the browser console script, the GUI page).
 * When packaged as a single executable they are embedded as SEA assets;
 * otherwise they are read from the repository checkout.
 */
export function readAsset(name) {
  try {
    const sea = nodeRequire()('node:sea');
    if (sea.isSea()) return sea.getAsset(name, 'utf8');
  } catch {
    /* not a single executable, or node < 20 */
  }
  return fs.readFileSync(assetPath(name), 'utf8');
}

/** Path of an asset in a checkout (for messages that tell the user where to find it). */
export function assetPath(name) {
  return path.join(ROOT, name === 'gui.html' ? 'src' : '', name);
}

/** True when running as a packaged single executable. */
export function isPackaged() {
  try {
    return Boolean(nodeRequire()('node:sea').isSea());
  } catch {
    return false;
  }
}
