// vk-archive browser export
//
// Paste this whole file into the browser console (F12 / Cmd+Option+J) on a VK
// messenger page (https://vk.ru/im or https://vk.com/im) where you are logged in.
// It uses the page's own API client, so no token is needed, and it saves one or
// more "vk-export-N.json" files to your Downloads folder. Then run:
//
//     node bin/vk-archive.js import ~/Downloads/vk-export-*.json
//     node bin/vk-archive.js run --offline
//
// Settings (change if needed, then paste again):
const SETTINGS = {
  startFrom: 0,        // skip this many conversations (to resume after closing the tab)
  onlyPeers: [],       // e.g. [123456, 2000000001] to export just these peer ids
  chatsPerFile: 40,    // how many conversations to put into one downloaded file
  maxFileMB: 80,       // ...or fewer, if the file would get bigger than this
  apiVersion: '5.199',
  pauseMs: 350,        // pause between API calls (VK allows ~3 per second)
};

(async () => {
  const w = typeof window !== 'undefined' ? window : globalThis;
  const vk = w.vkApi;
  if (!vk || typeof vk.api !== 'function') {
    console.error('vk-archive: window.vkApi.api is not available. Open https://vk.ru/im (or https://vk.com/im), log in, and paste the script again on that tab.');
    return;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log('%c[vk-archive]', 'color:#2a7ae2;font-weight:bold', ...a);

  async function call(method, params, attempt = 0) {
    await sleep(SETTINGS.pauseMs);
    let res;
    try {
      res = await vk.api(method, { v: SETTINGS.apiVersion, ...params });
    } catch (err) {
      const code = err?.error_code ?? err?.code ?? err?.error?.error_code;
      const msg = err?.error_msg ?? err?.message ?? err?.error?.error_msg ?? String(err);
      if ((code === 6 || code === 9 || code === 10 || code === 1) && attempt < 8) {
        const wait = Math.min(60000, 2000 * 2 ** attempt);
        log(`${method}: VK says [${code}] ${msg}; waiting ${wait / 1000}s`);
        await sleep(wait);
        return call(method, params, attempt + 1);
      }
      const e = new Error(`${method}: [${code}] ${msg}`);
      e.code = code;
      throw e;
    }
    // Some client versions return { response }, others the payload itself, others { error }.
    if (res && res.error && res.error.error_code) {
      const e = new Error(`${method}: [${res.error.error_code}] ${res.error.error_msg}`);
      e.code = res.error.error_code;
      if ((e.code === 6 || e.code === 9 || e.code === 10) && attempt < 8) {
        const wait = Math.min(60000, 2000 * 2 ** attempt);
        log(`${method}: VK says [${e.code}] ${res.error.error_msg}; waiting ${wait / 1000}s`);
        await sleep(wait);
        return call(method, params, attempt + 1);
      }
      throw e;
    }
    return res && res.response !== undefined ? res.response : res;
  }

  const save = w.__vkArchiveSave ?? ((name, text) => {
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  });

  // 1. who am I
  const meRes = await call('users.get', { fields: 'screen_name,photo_100' });
  const me = Array.isArray(meRes) ? meRes[0] : meRes;
  log(`Logged in as ${me.first_name} ${me.last_name} (id${me.id})`);

  // 2. every conversation: regular, archived, message requests
  const profiles = new Map();
  const groups = new Map();
  const absorb = (r) => {
    for (const p of r?.profiles ?? []) profiles.set(p.id, p);
    for (const g of r?.groups ?? []) groups.set(g.id, g);
  };
  const conversations = [];
  const seenPeers = new Set();
  for (const filter of ['all', 'archive', 'message_request']) {
    let offset = 0;
    for (;;) {
      let res;
      try {
        res = await call('messages.getConversations', { filter, offset, count: 200, extended: 1, fields: 'screen_name,photo_100' });
      } catch (err) {
        if (filter !== 'all') { log(`filter "${filter}" not supported here (${err.message}); skipping`); break; }
        throw err;
      }
      absorb(res);
      const items = res?.items ?? [];
      for (const it of items) {
        const id = it.conversation?.peer?.id;
        if (id && !seenPeers.has(id)) { seenPeers.add(id); conversations.push(it); }
      }
      offset += items.length;
      if (!items.length || offset >= (res.count ?? 0)) break;
    }
  }
  log(`Found ${conversations.length} conversations`);

  let todo = conversations;
  if (SETTINGS.onlyPeers.length) todo = todo.filter((c) => SETTINGS.onlyPeers.includes(c.conversation.peer.id));
  const startFrom = Math.min(SETTINGS.startFrom, todo.length);

  // 3. history of each one, saved in parts
  let part = 0;
  let chats = [];
  let videosWanted = new Map(); // key -> {owner_id,id,access_key}
  let approxBytes = 0;

  const collectVideos = (m) => {
    for (const a of m.attachments ?? []) {
      if (a.type === 'video' && a.video) {
        const v = a.video;
        videosWanted.set(`${v.owner_id}_${v.id}`, { owner_id: v.owner_id, id: v.id, access_key: v.access_key });
      }
      if (a.type === 'wall' && a.wall?.attachments) collectVideos({ attachments: a.wall.attachments });
    }
    for (const f of m.fwd_messages ?? []) collectVideos(f);
    if (m.reply_message) collectVideos(m.reply_message);
  };

  async function resolveVideos() {
    const videos = {};
    const keys = [...videosWanted.keys()];
    for (let i = 0; i < keys.length; i += 50) {
      const chunk = keys.slice(i, i + 50);
      const param = chunk.map((k) => { const v = videosWanted.get(k); return v.access_key ? `${k}_${v.access_key}` : k; }).join(',');
      try {
        const res = await call('video.get', { videos: param, count: chunk.length, extended: 0 });
        for (const it of res?.items ?? []) videos[`${it.owner_id}_${it.id}`] = it;
      } catch (err) {
        log(`video.get failed for ${chunk.length} videos: ${err.message}`);
      }
    }
    return videos;
  }

  async function flush(done) {
    if (!chats.length && !done) return;
    part += 1;
    const videos = await resolveVideos();
    const payload = {
      format: 'vk-archive-export/1',
      part,
      done,
      exported_at: new Date().toISOString(),
      me,
      total_conversations: conversations.length,
      conversations: done || part === 1 ? conversations : undefined,
      profiles: [...profiles.values()],
      groups: [...groups.values()],
      chats,
      videos,
    };
    const name = `vk-export-${String(part).padStart(3, '0')}.json`;
    save(name, JSON.stringify(payload));
    log(`Saved ${name} (${chats.length} chats, ${Object.keys(videos).length} videos)`);
    chats = [];
    videosWanted = new Map();
    approxBytes = 0;
  }

  for (let i = startFrom; i < todo.length; i += 1) {
    const conv = todo[i].conversation;
    const peerId = conv.peer.id;
    const title = conv.chat_settings?.title
      ?? (peerId > 0 ? `${profiles.get(peerId)?.first_name ?? ''} ${profiles.get(peerId)?.last_name ?? ''}`.trim() : groups.get(-peerId)?.name)
      ?? String(peerId);
    const tag = `[${i + 1}/${todo.length}] ${title} (${peerId})`;
    const entry = { peer_id: peerId, index: i, items: [], count: 0, error: null };
    try {
      let offset = 0;
      let empty = 0;
      const seen = new Set();
      for (;;) {
        const res = await call('messages.getHistory', { peer_id: peerId, offset, count: 200, extended: 1, fields: 'screen_name,photo_100' });
        absorb(res);
        const items = res?.items ?? [];
        entry.count = res?.count ?? entry.count;
        let fresh = 0;
        for (const m of items) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          entry.items.push(m);
          collectVideos(m);
          fresh += 1;
        }
        offset += items.length;
        if (!items.length || fresh === 0 && ++empty >= 2 || offset >= entry.count) break;
        if (offset % 1000 === 0) log(`${tag}: ${entry.items.length}/${entry.count}`);
      }
      log(`${tag}: ${entry.items.length} messages`);
    } catch (err) {
      entry.error = err.message;
      log(`${tag}: cannot read history (${err.message}); skipping`);
    }
    chats.push(entry);
    approxBytes += JSON.stringify(entry).length;
    if (chats.length >= SETTINGS.chatsPerFile || approxBytes > SETTINGS.maxFileMB * 1024 * 1024) {
      await flush(false);
      log(`If the tab closes, set startFrom: ${i + 1} in SETTINGS to continue from here.`);
    }
  }
  await flush(true);
  log('All done. Now run: node bin/vk-archive.js import ~/Downloads/vk-export-*.json   and then:   node bin/vk-archive.js run --offline');
  return { conversations: conversations.length, parts: part };
})();
