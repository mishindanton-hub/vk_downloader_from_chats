import fs from 'node:fs';
import path from 'node:path';
import { NameBook, describePeer, peerDir } from './peers.js';
import { ensureDir, readJson, writeJson } from './util.js';

export const VIDEO_CACHE = 'videos-cache.json';
export const EXPORT_META = 'export-meta.json';

/**
 * Import files produced by browser-export.js (pasted into the VK web page's console)
 * into the archive directory, in exactly the layout `run` produces after fetching
 * history: conversations.json, names.json, me.json, one directory per chat with
 * messages.jsonl + state.json (history_complete), and a video URL cache.
 * After this, `run --offline` downloads the media and renders everything.
 */
export function importExport({ files, out, log }) {
  if (!files?.length) throw new Error('No export files given. Usage: vk-archive import ~/Downloads/vk-export-*.json');
  ensureDir(out);
  const namesPath = path.join(out, 'names.json');
  const names = NameBook.fromJSON(readJson(namesPath, null));
  const convPath = path.join(out, 'conversations.json');
  const peersById = new Map((readJson(convPath, []) ?? []).map((p) => [p.peer_id, p]));
  const cachePath = path.join(out, VIDEO_CACHE);
  const videoCache = readJson(cachePath, {}) ?? {};

  const parts = files
    .map((f) => {
      const data = readJson(f, null);
      if (!data || data.format !== 'vk-archive-export/1') throw new Error(`${f}: not a vk-archive browser export (expected format "vk-archive-export/1")`);
      return { file: f, data };
    })
    .sort((a, b) => (a.data.part ?? 0) - (b.data.part ?? 0));

  let me = readJson(path.join(out, 'me.json'), null);
  let chatsImported = 0;
  let messages = 0;
  let sawDone = false;
  for (const { file, data } of parts) {
    log.info(`Importing ${path.basename(file)} (part ${data.part}${data.done ? ', last' : ''}, ${data.chats?.length ?? 0} chats)`);
    names.absorb({ profiles: data.profiles, groups: data.groups });
    if (data.me?.id) me = data.me;
    if (data.done) sawDone = true;
    if (data.user_agent) writeJson(path.join(out, EXPORT_META), { user_agent: data.user_agent, exported_at: data.exported_at });
    for (const item of data.conversations ?? []) {
      const p = describePeer(item, names);
      peersById.set(p.peer_id, p);
    }
    for (const [k, v] of Object.entries(data.videos ?? {})) videoCache[k] = v;

    for (const chat of data.chats ?? []) {
      let peer = peersById.get(chat.peer_id);
      if (!peer) {
        const id = chat.peer_id;
        peer = { peer_id: id, kind: id > 2000000000 ? 'chat' : id < 0 ? 'group' : 'user', title: names.name(id) };
        peersById.set(id, peer);
      }
      const dir = peerDir(out, peer);
      ensureDir(dir);
      const statePath = path.join(dir, 'state.json');
      if (chat.error) {
        writeJson(statePath, { peer_id: peer.peer_id, kind: peer.kind, title: peer.title, error: chat.error, source: 'browser' });
        continue;
      }
      const jsonl = path.join(dir, 'messages.jsonl');
      const tmp = `${jsonl}.tmp`;
      fs.writeFileSync(tmp, chat.items.map((m) => JSON.stringify(m)).join('\n') + (chat.items.length ? '\n' : ''));
      fs.renameSync(tmp, jsonl);
      const prev = readJson(statePath, {}) ?? {};
      writeJson(statePath, {
        ...prev,
        peer_id: peer.peer_id,
        kind: peer.kind,
        title: peer.title,
        total_count: chat.count,
        fetched: chat.items.length,
        history_complete: true,
        history_fetched_at: data.exported_at,
        source: 'browser',
        error: undefined,
      });
      chatsImported += 1;
      messages += chat.items.length;
    }
  }

  if (me?.id) {
    names.users.set(me.id, me);
    writeJson(path.join(out, 'me.json'), me);
  }
  writeJson(namesPath, names.toJSON());
  writeJson(convPath, [...peersById.values()]);
  writeJson(cachePath, videoCache);
  log.info(`Imported ${chatsImported} chats, ${messages} messages, ${Object.keys(videoCache).length} video records into ${out}`);
  if (!sawDone) log.warn('The last part (with "done": true) is missing: the browser export did not finish, or not all files were given. You can import the rest later.');
  return { chats: chatsImported, messages, me, done: sawDone };
}
