import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './util.js';

const PAGE = 200;

/**
 * Downloads the whole history of a peer into `<dir>/messages.jsonl`, newest first,
 * one JSON message per line, page by page, so a crash loses at most one page.
 * Resumable: on restart we continue from the number of lines already stored.
 *
 * Offset-based paging is stable as long as no new messages arrive in the middle
 * of a run, which is true for a dormant account. As a safety net we also dedupe by id.
 */
export async function fetchHistory({ api, dir, peer, names, log, onProgress }) {
  const jsonlPath = path.join(dir, 'messages.jsonl');
  const statePath = path.join(dir, 'state.json');
  const state = readJson(statePath, {}) ?? {};

  if (state.history_complete && fs.existsSync(jsonlPath)) {
    log.debug(`history already complete for ${peer.title}`);
    return { state, jsonlPath, skipped: true };
  }

  const seen = new Set();
  let stored = 0;
  if (fs.existsSync(jsonlPath)) {
    for (const line of fs.readFileSync(jsonlPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        seen.add(m.id);
        stored += 1;
      } catch {
        /* truncated last line from a crash: ignore */
      }
    }
    if (stored > 0) log.info(`  resuming from ${stored} already stored messages`);
  }

  const out = fs.createWriteStream(jsonlPath, { flags: stored > 0 ? 'a' : 'w' });
  let offset = stored;
  let total = state.total_count ?? null;
  let emptyPages = 0;
  try {
    for (;;) {
      const res = await api.call('messages.getHistory', {
        peer_id: peer.peer_id,
        offset,
        count: PAGE,
        extended: 1,
        fields: 'first_name,last_name,screen_name,photo_100,name,deactivated',
      });
      names.absorb(res);
      total = res.count;
      const items = res.items ?? [];
      let fresh = 0;
      for (const m of items) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        out.write(`${JSON.stringify(m)}\n`);
        fresh += 1;
      }
      stored += fresh;
      offset += items.length;
      onProgress?.({ fetched: stored, total });
      if (items.length === 0) break;
      if (fresh === 0) {
        emptyPages += 1;
        if (emptyPages >= 2) break;
      } else emptyPages = 0;
      if (offset >= total) break;
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }

  Object.assign(state, {
    peer_id: peer.peer_id,
    kind: peer.kind,
    title: peer.title,
    total_count: total,
    fetched: stored,
    history_complete: true,
    history_fetched_at: new Date().toISOString(),
  });
  writeJson(statePath, state);
  return { state, jsonlPath, skipped: false };
}

/** Read messages.jsonl back, oldest first. */
export function readMessages(jsonlPath) {
  if (!fs.existsSync(jsonlPath)) return [];
  const messages = [];
  for (const line of fs.readFileSync(jsonlPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      /* ignore broken line */
    }
  }
  messages.sort((a, b) => a.date - b.date || a.id - b.id);
  return messages;
}
