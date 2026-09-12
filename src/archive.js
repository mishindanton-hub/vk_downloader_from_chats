import fs from 'node:fs';
import path from 'node:path';
import { collectMedia, datedRel, pickVideoFile } from './attachments.js';
import { describeInFlight, downloadAll } from './download.js';
import { fetchHistory, readMessages } from './history.js';
import { NameBook, listConversations, peerDir } from './peers.js';
import { EXPORT_META, VIDEO_CACHE } from './import.js';
import { renderIndexHtml, writeChatOutputs } from './render.js';
import { writeStats } from './stats.js';
import { activity, ensureDir, extFromUrl, formatBytes, readJson, startHeartbeat, writeJson } from './util.js';

/**
 * The main loop: list every conversation, then for each one fetch the full
 * history, download all media, and render JSON/HTML/TXT. Everything is
 * resumable: re-running picks up where the previous run stopped.
 */
export async function runArchive(opts) {
  const stop = startHeartbeat(opts.log, { detail: describeInFlight });
  try {
    return await runArchiveInner(opts);
  } finally {
    stop();
    activity.clear();
  }
}

async function runArchiveInner({ api, out, log, peerFilter, flags = {}, concurrency = 4, userAgent }) {
  ensureDir(out);
  const namesPath = path.join(out, 'names.json');
  const names = NameBook.fromJSON(readJson(namesPath, null));
  const offline = !api;
  // Offline mode (after `import` of a browser export): everything comes from disk, no API calls at all.
  const videoCache = offline ? readJson(path.join(out, VIDEO_CACHE), {}) ?? {} : null;
  if (offline && !userAgent) {
    // Video links from the browser export are bound to the browser that requested them
    // (srcAg=CHROME_MAC etc.), so downloads must present the same identity.
    userAgent = readJson(path.join(out, EXPORT_META), null)?.user_agent ?? defaultBrowserUserAgent();
  }

  // Who am I? Needed to mark outgoing messages and for the index page.
  let me;
  if (offline) {
    me = readJson(path.join(out, 'me.json'), null);
    if (!me?.id) throw new Error(`${path.join(out, 'me.json')} not found. Run "vk-archive import <files>" first, or run without --offline.`);
  } else {
    const meRes = await api.call('users.get', { fields: 'screen_name,photo_100' });
    me = Array.isArray(meRes) ? meRes[0] : meRes;
    if (!me?.id) throw new Error('users.get did not return the current user; is the token valid?');
    names.users.set(me.id, me);
    writeJson(path.join(out, 'me.json'), me);
  }
  log.info(`${offline ? 'Offline mode. Archive of' : 'Logged in as'} ${me.first_name} ${me.last_name} (id${me.id})`);

  let peers;
  if (offline) {
    peers = readJson(path.join(out, 'conversations.json'), []) ?? [];
    log.info(`${peers.length} conversations on disk`);
  } else {
    log.info('Listing conversations...');
    peers = await listConversations(api, names, log);
    writeJson(path.join(out, 'conversations.json'), peers);
    writeJson(namesPath, names.toJSON());
    log.info(`Found ${peers.length} conversations`);
  }

  if (peerFilter?.length) {
    const wanted = new Set(peerFilter.map(Number));
    peers = peers.filter((p) => wanted.has(p.peer_id));
    const missing = [...wanted].filter((id) => !peers.some((p) => p.peer_id === id));
    // Allow archiving a peer that isn't in the conversation list (e.g. a chat hidden from the list).
    for (const id of missing) peers.push({ peer_id: id, kind: id > 2000000000 ? 'chat' : id < 0 ? 'group' : 'user', title: names.name(id) });
  }
  if (flags.skipGroups) peers = peers.filter((p) => p.kind !== 'group');

  // Offline: the text is all here already, so build readable pages for every chat first
  // (media placeholders where needed); they are rebuilt as each chat's media completes.
  if (offline) prerenderPages(out, peers, names, me, log);

  const summary = [];
  let pendingDownload = Promise.resolve();
  const total = peers.length;
  for (let i = 0; i < peers.length; i += 1) {
    const peer = peers[i];
    const dir = peerDir(out, peer);
    ensureDir(dir);
    const relDir = path.basename(dir);
    const tag = `[${i + 1}/${total}] ${peer.title} (${peer.peer_id})`;
    const entry = { ...peer, dir: relDir };
    summary.push(entry);

    // 1. history
    let state;
    if (offline) {
      state = readJson(path.join(dir, 'state.json'), {}) ?? {};
      if (state.error) {
        entry.status = `skipped: ${state.error}`;
        continue;
      }
      if (!state.history_complete || !fs.existsSync(path.join(dir, 'messages.jsonl'))) {
        log.warn(`${tag}: no history on disk; skipping (export it in the browser and import again)`);
        entry.status = 'no history';
        continue;
      }
    }
    if (offline) {
      log.info(`${tag}: history from browser export (${state.fetched} messages)`);
    } else {
      activity.set(`fetching history of ${peer.title}`);
      try {
        let lastLog = 0;
        const res = await fetchHistory({
          api,
          dir,
          peer,
          names,
          log,
          onProgress: ({ fetched, total: t }) => {
            if (Date.now() - lastLog > 3000) {
              log.info(`${tag}: ${fetched}/${t} messages`);
              lastLog = Date.now();
            }
          },
        });
        state = res.state;
        log.info(`${tag}: history ${res.skipped ? 'already complete' : 'done'} (${state.fetched} messages)`);
      } catch (err) {
        if (err.code === 917 || err.code === 15 || err.code === 7) {
          log.warn(`${tag}: no access to history (${err.message}); skipping`);
          entry.status = `skipped: ${err.body?.error_msg ?? err.message}`;
          writeJson(path.join(dir, 'state.json'), { peer_id: peer.peer_id, title: peer.title, error: err.message });
          continue;
        }
        throw err;
      }
    }
    writeJson(namesPath, names.toJSON());

    // 2. collect + resolve media (video URLs come from video.get)
    activity.set(`reading messages of ${peer.title}`);
    const messages = readMessages(path.join(dir, 'messages.jsonl'));
    entry.message_count = messages.length;
    const media = collectMedia(messages, {
      skipPhotos: flags.noPhotos,
      skipVideos: flags.noVideo,
      skipDocs: flags.noDocs,
      skipVoice: flags.noVoice,
      skipStickers: flags.noStickers,
      skipMusic: flags.noMusic,
    });
    const videoLinks = [];
    if (!flags.noVideo && media.videos.length) {
      const resolved = await resolveVideos(api, media.videos, flags.maxVideoQuality ?? 2160, log, videoCache);
      for (const v of resolved) {
        if (v.url) media.jobs.push({ key: v.key, kind: 'video', url: v.url, rel: datedRel(`media/videos/${v.key}_${v.quality}p.${extFromUrl(v.url, 'mp4')}`, v.date), title: v.title, msg_id: v.msg_id, date: v.date });
        else videoLinks.push({ key: v.key, title: v.title, url: v.link, reason: v.reason });
      }
    }
    if (Object.keys(media.unsupported).length) log.debug(`${tag}: unsupported attachment types: ${JSON.stringify(media.unsupported)}`);

    // Make sure we know every author's name before rendering.
    const ids = new Set();
    const collect = (m) => {
      if (m.from_id) ids.add(m.from_id);
      if (m.action?.member_id) ids.add(m.action.member_id);
      for (const f of m.fwd_messages ?? []) collect(f);
      if (m.reply_message) collect(m.reply_message);
    };
    messages.forEach(collect);
    if (!offline) {
      await names.resolveMissing(api, [...ids]);
      writeJson(namesPath, names.toJSON());
    }

    // 3. download (overlaps with fetching the next chat's history)
    await pendingDownload;
    const jobs = flags.textOnly ? [] : media.jobs;
    pendingDownload = (async () => {
      let lastLog = 0;
      const { index, stats } = await downloadAll(jobs, {
        dir,
        concurrency,
        log,
        userAgent,
        label: peer.title,
        retryFailed: flags.retryFailed,
        onProgress: (s) => {
          if (Date.now() - lastLog > 5000) {
            log.info(`${tag}: media ${s.done + s.failed + s.skipped}/${s.total} (${formatBytes(s.bytes)})`);
            lastLog = Date.now();
          }
        },
      });
      if (jobs.length) log.info(`${tag}: media done: ${stats.done} downloaded, ${stats.skipped} already present, ${stats.failed} failed, ${formatBytes(stats.bytes)}`);
      entry.media_ok = Object.values(index).filter((r) => r.status === 'ok').length;
      entry.media_failed = Object.values(index).filter((r) => r.status === 'failed').length;
      activity.set(`building the pages of ${peer.title} (${messages.length} messages)`);
      writeChatOutputs({ dir, peer, messages, names, index, me: me.id, videoLinks, links: media.links });
      writeJson(path.join(dir, 'state.json'), { ...state, media_complete: stats.failed === 0, media_updated_at: new Date().toISOString(), videos_not_downloaded: videoLinks.length });
      entry.status = 'ok';
      // Refresh the index after every chat so it is useful even mid-run.
      writeIndex(out, summary, me);
    })();
  }
  await pendingDownload;
  writeIndex(out, summary, me);
  activity.set('computing messaging statistics over all chats');
  writeStats(out, log);
  log.info(`\nDone. ${summary.length} chats.${offline ? '' : ` API calls: ${api.stats.calls} (${api.stats.retries} retries).`} Open ${path.join(out, 'index.html')}`);
  return summary;
}

function prerenderPages(out, peers, names, me, log) {
  const todo = peers.filter((peer) => {
    const dir = peerDir(out, peer);
    return fs.existsSync(path.join(dir, 'messages.jsonl')) && !fs.existsSync(path.join(dir, 'messages.html'));
  });
  if (!todo.length) return;
  log.info(`Building readable pages for ${todo.length} chats before downloading media...`);
  const summary = [];
  let lastLog = 0;
  for (const [i, peer] of todo.entries()) {
    const dir = peerDir(out, peer);
    activity.set(`building pages: ${peer.title} (${i + 1}/${todo.length})`);
    const messages = readMessages(path.join(dir, 'messages.jsonl'));
    const index = readJson(path.join(dir, 'media-index.json'), {}) ?? {};
    writeChatOutputs({ dir, peer, messages, names, index, me: me.id, videoLinks: [], links: [] });
    summary.push({ ...peer, dir: path.basename(dir), message_count: messages.length, media_ok: 0, media_failed: 0, status: 'text only, media pending' });
    if (Date.now() - lastLog > 5000) {
      log.info(`  pages ${i + 1}/${todo.length}`);
      lastLog = Date.now();
    }
  }
  const existing = readJson(path.join(out, 'summary.json'), []) ?? [];
  const seen = new Set(summary.map((s) => s.peer_id));
  writeIndex(out, [...existing.filter((s) => !seen.has(s.peer_id)), ...summary], me);
  log.info(`  pages done; open ${path.join(out, 'index.html')} any time while media downloads`);
}

function writeIndex(out, summary, me) {
  writeJson(path.join(out, 'summary.json'), summary);
  fs.writeFileSync(path.join(out, 'index.html'), renderIndexHtml(summary, me));
}

/**
 * Look up direct file URLs for videos via video.get (batched), or, in offline mode,
 * from the cache written by `import` (the browser export already called video.get).
 */
export async function resolveVideos(api, videos, maxQuality, log, cache = null) {
  const results = [];
  const byKey = new Map(videos.map((v) => [`${v.owner_id}_${v.id}`, v]));
  const ids = [...byKey.keys()];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const param = chunk.map((k) => {
      const v = byKey.get(k);
      return v.access_key ? `${k}_${v.access_key}` : k;
    });
    let items = [];
    if (cache) {
      items = chunk.map((k) => cache[k]).filter(Boolean);
    } else {
      try {
        const res = await api.call('video.get', { videos: param, count: chunk.length, extended: 0 });
        items = res?.items ?? [];
      } catch (err) {
        log.warn(`video.get failed for a batch of ${chunk.length}: ${err.message}`);
      }
    }
    const found = new Map(items.map((it) => [`${it.owner_id}_${it.id}`, it]));
    for (const k of chunk) {
      const v = byKey.get(k);
      const item = found.get(k);
      const link = `https://vk.com/video${k}`;
      if (!item) {
        results.push({ ...v, url: null, link, reason: 'not returned by video.get (deleted/private)' });
        continue;
      }
      const file = pickVideoFile(item, maxQuality);
      if (file) results.push({ ...v, title: item.title ?? v.title, url: file.url, quality: file.quality });
      else if (item.files?.external) results.push({ ...v, url: null, link: item.files.external, reason: 'external video (YouTube/Rutube etc.)' });
      else if (item.files?.hls) results.push({ ...v, url: null, link: item.player ?? link, hls: item.files.hls, reason: 'HLS only, use yt-dlp' });
      else results.push({ ...v, url: null, link: item.player ?? link, reason: 'no direct file URL from API (try yt-dlp on the link)' });
    }
  }
  return results;
}

/** Rebuild JSON/HTML/TXT from what is already on disk, without any API calls. */
export function rerender({ out, log }) {
  const names = NameBook.fromJSON(readJson(path.join(out, 'names.json'), null));
  const me = readJson(path.join(out, 'me.json'), null);
  const summary = [];
  for (const d of fs.readdirSync(out)) {
    const dir = path.join(out, d);
    const statePath = path.join(dir, 'state.json');
    if (!fs.existsSync(statePath)) continue;
    const state = readJson(statePath, {});
    const peer = { peer_id: state.peer_id, kind: state.kind ?? d.split('_')[0], title: state.title ?? d };
    if (!fs.existsSync(path.join(dir, 'messages.jsonl'))) {
      summary.push({ ...peer, dir: d, status: state.error ? `skipped: ${state.error}` : 'no data' });
      continue;
    }
    const messages = readMessages(path.join(dir, 'messages.jsonl'));
    const index = readJson(path.join(dir, 'media-index.json'), {}) ?? {};
    const prev = readJson(path.join(dir, 'messages.json'), {}) ?? {};
    writeChatOutputs({ dir, peer, messages, names, index, me: me?.id, videoLinks: prev.videos_not_downloaded ?? [], links: prev.external_links ?? [] });
    summary.push({
      ...peer,
      dir: d,
      message_count: messages.length,
      media_ok: Object.values(index).filter((r) => r.status === 'ok').length,
      media_failed: Object.values(index).filter((r) => r.status === 'failed').length,
      last_message_date: messages[messages.length - 1]?.date,
      status: state.error ? `skipped: ${state.error}` : state.history_complete ? 'ok' : 'incomplete',
    });
    log.info(`rendered ${d} (${messages.length} messages)`);
  }
  writeIndex(out, summary, me);
  writeStats(out, log);
  return summary;
}

/** A current desktop-browser identity for this OS, used when the export did not record one. */
export function defaultBrowserUserAgent() {
  const os = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36`;
}
