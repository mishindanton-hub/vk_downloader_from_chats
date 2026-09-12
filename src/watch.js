import fs from 'node:fs';
import path from 'node:path';
import { importExport } from './import.js';
import { activity, readJson, sleep, writeJson } from './util.js';

export const PART_RE = /^vk-export-\d+\.json$/;

/**
 * Poll `downloads` for vk-export-NNN.json files saved by browser-export.js and
 * import each one into `out` as soon as it is complete on disk. Files already
 * imported (tracked in <out>/imported-parts.json by name+size+mtime) are skipped.
 *
 * Resolves when the part marked done:true has been imported, or when shouldStop()
 * returns true. Returns { done, parts } where parts is the number imported so far.
 */
export async function watchDownloads({ downloads, out, log, shouldStop = () => false, onPart, onIdle, pollMs = 2000 }) {
  const trackerPath = path.join(out, 'imported-parts.json');
  const imported = readJson(trackerPath, {}) ?? {};
  const sizes = new Map();
  let parts = Object.values(imported).filter((t) => !t.ignored).length;
  let done = Object.values(imported).some((t) => t.done);
  while (!done && !shouldStop()) {
    const names = fs.existsSync(downloads) ? fs.readdirSync(downloads).filter((n) => PART_RE.test(n)).sort() : [];
    for (const name of names) {
      const file = path.join(downloads, name);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const key = `${name}:${st.size}:${Math.floor(st.mtimeMs)}`;
      if (imported[key]) continue;
      // Wait until the size is stable, then check the file parses (still being written otherwise).
      if (sizes.get(name) !== st.size) {
        sizes.set(name, st.size);
        continue;
      }
      let data;
      try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      if (data?.format !== 'vk-archive-export/1') {
        log.info(`  ${name} is not a VK Archive export file; ignoring it.`);
        imported[key] = { ignored: true };
        writeJson(trackerPath, imported);
        continue;
      }
      log.info(`  importing ${name} (${(st.size / 1048576).toFixed(0)} MB) ...`);
      activity.set(`importing ${name}`);
      let res;
      try {
        res = importExport({ files: [file], out, log: { ...log, info() {}, debug() {} } });
      } finally {
        activity.clear();
      }
      parts += 1;
      imported[key] = { imported_at: new Date().toISOString(), chats: res.chats, part: data.part, done: Boolean(data.done) };
      writeJson(trackerPath, imported);
      log.info(`  + ${name}: ${res.chats} chats, ${res.messages} messages imported${data.done ? ' (last part)' : ''}`);
      onPart?.({ name, part: data.part, chats: res.chats, messages: res.messages, done: Boolean(data.done), parts });
      if (data.done) done = true;
    }
    if (!done) {
      onIdle?.({ parts });
      await sleep(pollMs);
    }
  }
  return { done, parts };
}

/** How many chats the archive on disk knows about (0 if none). */
export function archivedChatCount(out) {
  return readJson(path.join(out, 'conversations.json'), [])?.length ?? 0;
}
