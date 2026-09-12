import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJson } from './util.js';

export const CONFIG_FILE = process.env.VK_ARCHIVE_CONFIG || path.join(os.homedir(), '.vk-archiver.json');

export function loadConfig() {
  return readJson(CONFIG_FILE, {}) ?? {};
}

export function saveConfig(cfg) {
  writeJson(CONFIG_FILE, cfg);
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    /* windows */
  }
  return CONFIG_FILE;
}

/** Resolve the access token: CLI flag > env > config file. */
export function resolveToken(flagToken) {
  if (flagToken) return { token: flagToken, source: '--token' };
  if (process.env.VK_TOKEN) return { token: process.env.VK_TOKEN, source: 'VK_TOKEN env' };
  const cfg = loadConfig();
  if (cfg.access_token) return { token: cfg.access_token, source: CONFIG_FILE, app: cfg.app };
  return { token: null };
}
