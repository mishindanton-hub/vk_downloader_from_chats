import { extFromUrl, sanitizeName } from './util.js';

/**
 * Walks every message (including forwarded messages, replies and wall posts inside
 * attachments) and produces a deduplicated list of download jobs.
 *
 * A job: { key, kind, url, rel, title, size, msg_id }
 *   key  - stable VK identity, e.g. photo123_456 (used for dedupe and in media-index.json)
 *   rel  - path relative to the chat directory where the file will live
 *   url  - direct URL, or null for videos that need a video.get lookup first
 */
export function collectMedia(messages, opts = {}) {
  const jobs = new Map();
  const videos = new Map(); // key -> { owner_id, id, access_key, title }
  const links = []; // things we can't download but want to remember
  const unsupported = new Map(); // type -> count

  const add = (job) => {
    if (!job || !job.key) return;
    if (!jobs.has(job.key)) jobs.set(job.key, job);
  };

  const walk = (msg, depth = 0) => {
    if (!msg || depth > 30) return;
    for (const att of msg.attachments ?? []) handleAttachment(att, msg, depth);
    for (const f of msg.fwd_messages ?? []) walk(f, depth + 1);
    if (msg.reply_message) walk(msg.reply_message, depth + 1);
    if (msg.action?.photo) {
      const url = msg.action.photo.photo_200 || msg.action.photo.photo_100 || msg.action.photo.photo_50;
      if (url) add({ key: `chatphoto${msg.id}`, kind: 'photo', url, rel: `media/other/chat_photo_${msg.id}.${extFromUrl(url, 'jpg')}`, msg_id: msg.id });
    }
  };

  const handleAttachment = (att, msg, depth) => {
    const type = att.type;
    const obj = att[type];
    if (!obj) return;
    switch (type) {
      case 'photo': {
        if (opts.skipPhotos) return;
        const key = `photo${obj.owner_id}_${obj.id}`;
        const [url, ...alternatives] = photoUrls(obj);
        if (!url) return;
        add({ key, kind: 'photo', url, alternatives, rel: `media/photos/${key}.${extFromUrl(url, 'jpg')}`, msg_id: msg.id, date: msg.date });
        return;
      }
      case 'video': {
        if (opts.skipVideos) return;
        const key = `video${obj.owner_id}_${obj.id}`;
        if (!videos.has(key)) {
          videos.set(key, { key, owner_id: obj.owner_id, id: obj.id, access_key: obj.access_key, title: obj.title, duration: obj.duration, msg_id: msg.id, date: msg.date, platform: obj.platform });
        }
        const thumb = bestImageUrl(obj.image ?? obj.first_frame);
        if (thumb) add({ key: `${key}_thumb`, kind: 'video_thumb', url: thumb, rel: `media/videos/${key}_thumb.${extFromUrl(thumb, 'jpg')}`, msg_id: msg.id });
        return;
      }
      case 'doc': {
        if (opts.skipDocs) return;
        const key = `doc${obj.owner_id}_${obj.id}`;
        if (!obj.url) return;
        const ext = sanitizeName(obj.ext || extFromUrl(obj.url, 'bin'), 10).toLowerCase();
        const title = sanitizeName((obj.title || '').replace(new RegExp(`\\.${ext}$`, 'i'), ''), 50);
        add({ key, kind: 'doc', url: obj.url, rel: `media/docs/${key}_${title}.${ext}`, title: obj.title, size: obj.size, msg_id: msg.id, date: msg.date });
        return;
      }
      case 'audio_message': {
        if (opts.skipVoice) return;
        const key = `am${obj.owner_id}_${obj.id}`;
        const url = obj.link_mp3 || obj.link_ogg;
        if (!url) return;
        add({ key, kind: 'voice', url, rel: `media/voice/${key}.${obj.link_mp3 ? 'mp3' : 'ogg'}`, size: undefined, duration: obj.duration, msg_id: msg.id, date: msg.date });
        return;
      }
      case 'audio': {
        const key = `audio${obj.owner_id}_${obj.id}`;
        const title = `${obj.artist ?? ''} - ${obj.title ?? ''}`.trim();
        if (!opts.skipMusic && obj.url && !/\.m3u8/.test(obj.url)) {
          add({ key, kind: 'music', url: obj.url, rel: `media/music/${key}_${sanitizeName(title, 60)}.mp3`, title, msg_id: msg.id, date: msg.date });
        } else {
          links.push({ kind: 'audio', key, title, url: obj.url || null, msg_id: msg.id });
        }
        return;
      }
      case 'sticker': {
        if (opts.skipStickers) return;
        const key = `sticker${obj.sticker_id}`;
        const url = bestImageUrl(obj.images) ?? bestImageUrl(obj.images_with_background) ?? obj.photo_512 ?? obj.photo_256;
        if (!url) return;
        add({ key, kind: 'sticker', url, rel: `media/stickers/${key}.${extFromUrl(url, 'png')}`, msg_id: msg.id });
        return;
      }
      case 'graffiti': {
        const key = `graffiti${obj.owner_id}_${obj.id}`;
        const url = obj.url || bestPhotoUrl(obj.photo);
        if (!url) return;
        add({ key, kind: 'graffiti', url, rel: `media/other/${key}.${extFromUrl(url, 'png')}`, msg_id: msg.id });
        return;
      }
      case 'gift': {
        const key = `gift${obj.id}`;
        const url = obj.thumb_256 || obj.thumb_96 || obj.thumb_48;
        if (!url) return;
        add({ key, kind: 'gift', url, rel: `media/other/${key}.${extFromUrl(url, 'png')}`, msg_id: msg.id });
        return;
      }
      case 'market': {
        const key = `market${obj.owner_id}_${obj.id}`;
        const url = obj.thumb_photo || bestPhotoUrl(obj.photos?.[0]);
        if (url) add({ key, kind: 'market', url, rel: `media/other/${key}.${extFromUrl(url, 'jpg')}`, title: obj.title, msg_id: msg.id });
        links.push({ kind: 'market', key, title: obj.title, url: `https://vk.com/market${obj.owner_id}?w=product${obj.owner_id}_${obj.id}`, msg_id: msg.id });
        return;
      }
      case 'wall': {
        // A repost: harvest everything inside it too.
        walk({ id: msg.id, date: msg.date, attachments: obj.attachments ?? [] }, depth + 1);
        for (const c of obj.copy_history ?? []) walk({ id: msg.id, date: msg.date, attachments: c.attachments ?? [] }, depth + 1);
        links.push({ kind: 'wall', key: `wall${obj.from_id ?? obj.owner_id}_${obj.id}`, title: (obj.text || '').slice(0, 80), url: `https://vk.com/wall${obj.from_id ?? obj.owner_id}_${obj.id}`, msg_id: msg.id });
        return;
      }
      case 'wall_reply': {
        walk({ id: msg.id, date: msg.date, attachments: obj.attachments ?? [] }, depth + 1);
        return;
      }
      case 'story': {
        if (obj.photo) handleAttachment({ type: 'photo', photo: obj.photo }, msg, depth + 1);
        if (obj.video) handleAttachment({ type: 'video', video: obj.video }, msg, depth + 1);
        return;
      }
      case 'link': {
        links.push({ kind: 'link', key: `link${msg.id}`, title: obj.title, url: obj.url, msg_id: msg.id });
        return;
      }
      default:
        unsupported.set(type, (unsupported.get(type) ?? 0) + 1);
    }
  };

  for (const m of messages) walk(m);
  return { jobs: [...jobs.values()], videos: [...videos.values()], links, unsupported: Object.fromEntries(unsupported) };
}

/** Pick the largest size of a photo object. Handles both `sizes[]` (modern) and photo_XXX fields (legacy). */
export function bestPhotoUrl(photo) {
  return photoUrls(photo)[0] ?? null;
}

/** Every size URL of a photo, largest first. VK sometimes fails (HTTP 424) for one size but serves the others. */
export function photoUrls(photo) {
  if (!photo) return [];
  let urls = [];
  if (Array.isArray(photo.sizes) && photo.sizes.length) {
    urls = [...photo.sizes].sort((a, b) => area(b) - area(a)).map((sz) => sz.url || sz.src);
  } else {
    const legacy = ['photo_2560', 'photo_1280', 'photo_807', 'photo_604', 'photo_130', 'photo_75'];
    urls = legacy.map((k) => photo[k]);
  }
  urls = urls.filter(Boolean);
  // Last resort: the plain file without VK's size/signature parameters sometimes still answers.
  const bare = urls.map((u) => u.split('?')[0]).filter((u) => /\.(jpe?g|png|webp|gif)$/i.test(u));
  return [...new Set([...urls, ...bare])];
}

const TYPE_RANK = { w: 10, z: 9, y: 8, x: 7, r: 6, q: 5, p: 4, o: 3, m: 2, s: 1 };
function area(size) {
  const a = (size.width ?? 0) * (size.height ?? 0);
  if (a > 0) return a;
  return TYPE_RANK[size.type] ?? 0;
}

export function bestImageUrl(images) {
  if (!Array.isArray(images) || !images.length) return null;
  const ranked = [...images].sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
  return ranked[0].url || null;
}

export const VIDEO_QUALITIES = ['mp4_144', 'mp4_240', 'mp4_360', 'mp4_480', 'mp4_720', 'mp4_1080', 'mp4_1440', 'mp4_2160'];

/**
 * Given a video.get item, choose the best direct mp4 URL not exceeding maxQuality.
 * Returns { url, quality } or null when the video has no downloadable file
 * (external YouTube/Rutube embeds, HLS-only, private, deleted).
 */
export function pickVideoFile(item, maxQuality = 2160) {
  const files = item?.files ?? {};
  let best = null;
  for (const q of VIDEO_QUALITIES) {
    const px = Number(q.slice(4));
    if (px > maxQuality) continue;
    if (files[q]) best = { url: files[q], quality: px };
  }
  return best;
}
