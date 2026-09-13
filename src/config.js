import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJson } from './util.js';

/**
 * Where the settings and the (optional) token live. Read lazily, not captured at
 * import time, so VK_ARCHIVE_CONFIG set later in the process still takes effect.
 */
export function configFile() {
  return process.env.VK_ARCHIVE_CONFIG || path.join(os.homedir(), '.vk-archiver.json');
}

export function loadConfig() {
  return readJson(configFile(), {}) ?? {};
}

export function saveConfig(cfg) {
  const file = configFile();
  writeJson(file, cfg);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
  return file;
}

/** Resolve the access token: CLI flag > env > config file. */
export function resolveToken(flagToken) {
  if (flagToken) return { token: flagToken, source: '--token' };
  if (process.env.VK_TOKEN) return { token: process.env.VK_TOKEN, source: 'VK_TOKEN env' };
  const cfg = loadConfig();
  if (cfg.access_token) return { token: cfg.access_token, source: configFile(), app: cfg.app, domain: cfg.domain };
  return { token: null };
}
