import fs from 'node:fs';
import path from 'node:path';
import { escapeHtml, formatBytes, formatDate, formatDay, writeJson } from './util.js';

/** Write messages.json, messages.html and messages.txt for one chat. */
export function writeChatOutputs({ dir, peer, messages, names, index, me, videoLinks = [], links = [] }) {
  const participants = new Set();
  const collectIds = (m) => {
    if (m.from_id) participants.add(m.from_id);
    if (m.action?.member_id) participants.add(m.action.member_id);
    for (const f of m.fwd_messages ?? []) collectIds(f);
    if (m.reply_message) collectIds(m.reply_message);
  };
  messages.forEach(collectIds);

  const people = {};
  for (const id of participants) people[id] = names.name(id);

  writeJson(path.join(dir, 'messages.json'), {
    peer,
    exported_at: new Date().toISOString(),
    message_count: messages.length,
    participants: people,
    media: index,
    external_links: links,
    videos_not_downloaded: videoLinks,
    messages,
  });
  fs.writeFileSync(path.join(dir, 'messages.html'), renderHtml({ peer, messages, names, index, me, videoLinks }));
  fs.writeFileSync(path.join(dir, 'messages.txt'), renderTxt({ peer, messages, names, index }));
  if (videoLinks.length) {
    fs.writeFileSync(path.join(dir, 'videos-not-downloaded.txt'), `${videoLinks.map((v) => v.url).join('\n')}\n`);
  }
}

// ---------- helpers ----------

function nameLink(id, names) {
  const n = escapeHtml(names.name(id));
  const href = id > 0 ? `https://vk.com/id${id}` : `https://vk.com/club${-id}`;
  return `<a class="who" href="${href}">${n}</a>`;
}

/** Escape text, keep line breaks, linkify URLs and VK [id123|Name] mentions. */
export function formatText(text) {
  if (!text) return '';
  let s = escapeHtml(text);
  // URLs first, then mentions, so the href we generate for a mention is not linkified again.
  s = s.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1">$1</a>');
  s = s.replace(/\[(id|club|public)(\d+)\|([^\]]+)\]/g, (_, kind, id, label) => {
    const slug = kind === 'id' ? `id${id}` : `club${id}`;
    return `<a href="https://vk.com/${slug}">${label}</a>`;
  });
  return s.replace(/\n/g, '<br>');
}

function actionText(m, names) {
  const a = m.action;
  if (!a) return '';
  const who = names.name(m.from_id);
  const member = a.member_id ? names.name(a.member_id) : '';
  switch (a.type) {
    case 'chat_create':
      return `${who} created the chat "${a.text ?? ''}"`;
    case 'chat_title_update':
      return `${who} renamed the chat to "${a.text ?? ''}"`;
    case 'chat_photo_update':
      return `${who} updated the chat photo`;
    case 'chat_photo_remove':
      return `${who} removed the chat photo`;
    case 'chat_invite_user':
      return a.member_id === m.from_id ? `${who} returned to the chat` : `${who} invited ${member}`;
    case 'chat_invite_user_by_link':
      return `${who} joined via invite link`;
    case 'chat_kick_user':
      return a.member_id === m.from_id ? `${who} left the chat` : `${who} removed ${member}`;
    case 'chat_pin_message':
      return `${who} pinned a message${a.message ? `: "${a.message}"` : ''}`;
    case 'chat_unpin_message':
      return `${who} unpinned a message`;
    case 'chat_screenshot':
      return `${who} took a screenshot`;
    default:
      return `${who}: ${a.type}`;
  }
}

function attKey(att) {
  const o = att[att.type];
  if (!o) return null;
  switch (att.type) {
    case 'photo':
      return `photo${o.owner_id}_${o.id}`;
    case 'video':
      return `video${o.owner_id}_${o.id}`;
    case 'doc':
      return `doc${o.owner_id}_${o.id}`;
    case 'audio_message':
      return `am${o.owner_id}_${o.id}`;
    case 'audio':
      return `audio${o.owner_id}_${o.id}`;
    case 'sticker':
      return `sticker${o.sticker_id}`;
    case 'graffiti':
      return `graffiti${o.owner_id}_${o.id}`;
    case 'gift':
      return `gift${o.id}`;
    case 'market':
      return `market${o.owner_id}_${o.id}`;
    default:
      return null;
  }
}

function localPath(index, key) {
  const rec = index?.[key];
  return rec?.status === 'ok' ? rec.path : null;
}

function renderAttachment(att, index, names, depth) {
  const type = att.type;
  const o = att[type];
  if (!o) return '';
  const key = attKey(att);
  const local = key ? localPath(index, key) : null;
  const enc = (p) => encodeURI(p);
  switch (type) {
    case 'photo': {
      if (local) return `<a class="att photo" href="${enc(local)}" target="_blank"><img loading="lazy" src="${enc(local)}" alt="photo"></a>`;
      const why = index[key]?.error ? ` (${escapeHtml(String(index[key].error).replace(/ for https?:\S+/, ''))})` : '';
      const vkLink = `https://vk.com/photo${o.owner_id}_${o.id}${o.access_key ? `_${o.access_key}` : ''}`;
      return `<div class="att missing">📷 photo not downloaded${why} · <a href="${vkLink}" target="_blank">open on VK</a></div>`;
    }
    case 'video': {
      const link = `https://vk.com/video${o.owner_id}_${o.id}`;
      const title = escapeHtml(o.title || 'video');
      if (local) return `<div class="att video"><video controls preload="none" src="${enc(local)}" poster="${enc(localPath(index, `${key}_thumb`) ?? '')}"></video><div class="cap">${title}</div></div>`;
      const thumb = localPath(index, `${key}_thumb`);
      return `<div class="att video missing"><a href="${link}" target="_blank">${thumb ? `<img loading="lazy" src="${enc(thumb)}" alt="">` : ''}<div class="cap">▶ ${title} (not downloaded, ${o.duration ?? '?'}s)</div></a></div>`;
    }
    case 'doc': {
      const title = escapeHtml(o.title || key);
      const size = o.size ? ` (${formatBytes(o.size)})` : '';
      if (local) {
        const isImg = /\.(jpe?g|png|gif|webp)$/i.test(local);
        return isImg
          ? `<a class="att photo" href="${enc(local)}" target="_blank"><img loading="lazy" src="${enc(local)}" alt="${title}"><div class="cap">${title}</div></a>`
          : `<div class="att doc"><a href="${enc(local)}" download>📎 ${title}</a>${size}</div>`;
      }
      return `<div class="att doc missing">📎 ${title}${size} <a href="${escapeHtml(o.url ?? '')}">[online]</a></div>`;
    }
    case 'audio_message': {
      if (local) return `<div class="att voice"><audio controls preload="none" src="${enc(local)}"></audio> <span class="cap">${o.duration ?? ''}s</span></div>`;
      return `<div class="att voice missing">🎤 voice message (${o.duration ?? '?'}s, not downloaded)</div>`;
    }
    case 'audio': {
      const title = escapeHtml(`${o.artist ?? ''} — ${o.title ?? ''}`);
      if (local) return `<div class="att music"><audio controls preload="none" src="${enc(local)}"></audio> <span class="cap">${title}</span></div>`;
      return `<div class="att music">🎵 ${title}</div>`;
    }
    case 'sticker':
      if (local) return `<img class="att sticker" loading="lazy" src="${enc(local)}" alt="sticker">`;
      return `<div class="att missing">[sticker]</div>`;
    case 'graffiti':
    case 'gift':
    case 'market': {
      if (local) return `<a class="att photo" href="${enc(local)}" target="_blank"><img loading="lazy" src="${enc(local)}" alt="${type}"></a>`;
      return `<div class="att missing">[${type}]</div>`;
    }
    case 'link':
      return `<div class="att link">🔗 <a href="${escapeHtml(o.url)}" target="_blank">${escapeHtml(o.title || o.url)}</a></div>`;
    case 'wall': {
      const inner = (o.attachments ?? []).map((a) => renderAttachment(a, index, names, depth + 1)).join('');
      const hist = (o.copy_history ?? [])
        .map((c) => `<blockquote class="wall">${formatText(c.text)}${(c.attachments ?? []).map((a) => renderAttachment(a, index, names, depth + 1)).join('')}</blockquote>`)
        .join('');
      const author = o.from_id ?? o.owner_id;
      return `<blockquote class="wall">📰 <a href="https://vk.com/wall${author}_${o.id}" target="_blank">post by ${escapeHtml(names.name(author))}</a><div>${formatText(o.text)}</div>${inner}${hist}</blockquote>`;
    }
    case 'call':
      return `<div class="att">📞 call ${o.state ?? ''} ${o.duration ? `${o.duration}s` : ''}</div>`;
    case 'poll':
      return `<div class="att">📊 poll: ${escapeHtml(o.question ?? '')}</div>`;
    default:
      return `<div class="att">[${escapeHtml(type)}]</div>`;
  }
}

function renderMessage(m, ctx, depth = 0) {
  const { names, index, me } = ctx;
  const out = m.from_id === me || m.out === 1;
  if (m.action && depth === 0) {
    return `<div class="sys" id="m${m.id}"><span class="t">${formatDate(m.date).slice(11, 16)}</span> ${escapeHtml(actionText(m, names))}</div>`;
  }
  const parts = [];
  parts.push(`<div class="hdr">${nameLink(m.from_id, names)} <span class="t" title="${formatDate(m.date)}">${depth ? formatDate(m.date) : formatDate(m.date).slice(11, 16)}</span>${m.important ? ' ⭐' : ''}${m.update_time ? ' <span class="edited">(edited)</span>' : ''}</div>`);
  if (m.text) parts.push(`<div class="text">${formatText(m.text)}</div>`);
  if (m.geo) parts.push(`<div class="att">📍 ${escapeHtml(m.geo.place?.title ?? `${m.geo.coordinates?.latitude}, ${m.geo.coordinates?.longitude}`)}</div>`);
  if (m.attachments?.length) parts.push(`<div class="atts">${m.attachments.map((a) => renderAttachment(a, index, names, depth)).join('')}</div>`);
  if (m.reply_message) parts.push(`<div class="reply">↩ ${renderMessage(m.reply_message, ctx, depth + 1)}</div>`);
  if (m.fwd_messages?.length) parts.push(`<div class="fwd">${m.fwd_messages.map((f) => renderMessage(f, ctx, depth + 1)).join('')}</div>`);
  return `<div class="msg${out ? ' out' : ''}${depth ? ' nested' : ''}" id="${depth ? '' : `m${m.id}`}">${parts.join('')}</div>`;
}

export const CSS = `
:root{--bg:#f4f5f7;--card:#fff;--out:#e7f3ff;--txt:#111;--muted:#6b7280;--line:#e5e7eb;--link:#2a5885}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--card:#1b1e26;--out:#1e2a3d;--txt:#e5e7eb;--muted:#9aa3b2;--line:#2b303b;--link:#8ab4f8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--link)}header{position:sticky;top:0;background:var(--card);border-bottom:1px solid var(--line);padding:12px 16px;z-index:2}
header h1{margin:0;font-size:18px}header .meta{color:var(--muted);font-size:13px}
main{max-width:900px;margin:0 auto;padding:16px}
.day{text-align:center;color:var(--muted);font-size:13px;margin:22px 0 10px}
.msg{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 12px;margin:6px 0;max-width:85%;overflow-wrap:anywhere}
.msg.out{margin-left:auto;background:var(--out)}
.msg.nested{max-width:100%;margin:4px 0;background:transparent;border-left:3px solid var(--line);border-radius:0;padding:4px 10px}
.hdr{font-size:13px;color:var(--muted)}.hdr .who{font-weight:600;text-decoration:none}.t{margin-left:6px}.edited{font-style:italic}
.text{white-space:normal;margin-top:2px}
.sys{text-align:center;color:var(--muted);font-size:13px;margin:8px 0}
.atts{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.att img{max-width:320px;max-height:320px;border-radius:8px;display:block}
.att.sticker{max-width:128px}
.att video{max-width:420px;width:100%;border-radius:8px;display:block}
.att .cap{font-size:12px;color:var(--muted)}
.att.missing{color:var(--muted);font-size:13px}
.reply,.fwd{margin-top:6px}
blockquote.wall{margin:6px 0;padding:6px 10px;border-left:3px solid var(--link);background:rgba(128,128,128,.08);border-radius:6px}
.reply{font-size:14px}
footer{color:var(--muted);font-size:12px;text-align:center;padding:24px}
`;

export function renderHtml({ peer, messages, names, index, me, videoLinks = [] }) {
  const ctx = { names, index, me };
  const body = [];
  let lastDay = null;
  for (const m of messages) {
    const day = formatDay(m.date);
    if (day !== lastDay) {
      body.push(`<div class="day">${day}</div>`);
      lastDay = day;
    }
    body.push(renderMessage(m, ctx));
  }
  const first = messages[0]?.date;
  const last = messages[messages.length - 1]?.date;
  const mediaOk = Object.values(index ?? {}).filter((r) => r.status === 'ok').length;
  const title = escapeHtml(peer.title);
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${CSS}</style></head><body>
<header><h1>${title}</h1><div class="meta">${peer.kind} · peer ${peer.peer_id} · ${messages.length} messages${first ? ` · ${formatDay(first)} — ${formatDay(last)}` : ''} · ${mediaOk} media files${videoLinks.length ? ` · ${videoLinks.length} videos not downloaded (see videos-not-downloaded.txt)` : ''} · <a href="../index.html">all chats</a></div></header>
<main>${body.join('\n')}</main>
<footer>Exported with vk-chat-archiver</footer></body></html>`;
}

function txtAttachment(att, index) {
  const key = attKey(att);
  const local = key ? localPath(index, key) : null;
  const o = att[att.type] ?? {};
  switch (att.type) {
    case 'link':
      return `[link: ${o.url}]`;
    case 'wall':
      return `[wall post https://vk.com/wall${o.from_id ?? o.owner_id}_${o.id}: ${(o.text ?? '').replace(/\s+/g, ' ').slice(0, 120)}]`;
    case 'audio':
      return `[audio: ${o.artist ?? ''} - ${o.title ?? ''}${local ? ` -> ${local}` : ''}]`;
    case 'video':
      return `[video: ${o.title ?? ''} ${local ? `-> ${local}` : `https://vk.com/video${o.owner_id}_${o.id}`}]`;
    default:
      return `[${att.type}${o.title ? `: ${o.title}` : ''}${local ? ` -> ${local}` : ''}]`;
  }
}

function txtMessage(m, ctx, indent = '') {
  const { names, index } = ctx;
  const lines = [];
  if (m.action) {
    lines.push(`${indent}[${formatDate(m.date)}] * ${actionText(m, names)}`);
    return lines.join('\n');
  }
  const atts = (m.attachments ?? []).map((a) => txtAttachment(a, index)).join(' ');
  const text = (m.text ?? '').replace(/\n/g, `\n${indent}    `);
  lines.push(`${indent}[${formatDate(m.date)}] ${names.name(m.from_id)}: ${text}${atts ? ` ${atts}` : ''}`);
  if (m.reply_message) lines.push(`${indent}  > reply to:`, txtMessage(m.reply_message, ctx, `${indent}    `));
  for (const f of m.fwd_messages ?? []) lines.push(`${indent}  > forwarded:`, txtMessage(f, ctx, `${indent}    `));
  return lines.join('\n');
}

export function renderTxt({ peer, messages, names, index }) {
  const ctx = { names, index };
  const head = `# ${peer.title} (${peer.kind} ${peer.peer_id}), ${messages.length} messages\n\n`;
  return head + messages.map((m) => txtMessage(m, ctx)).join('\n') + '\n';
}

/** Root index.html listing every archived chat. */
export function renderIndexHtml(chats, me) {
  const rows = chats
    .sort((a, b) => (b.last_message_date ?? 0) - (a.last_message_date ?? 0))
    .map(
      (c) =>
        `<tr><td><a href="${encodeURI(c.dir)}/messages.html">${escapeHtml(c.title)}</a>${c.is_archived ? ' <span class="tag">archived</span>' : ''}</td><td>${c.kind}</td><td class="n">${c.message_count ?? '?'}</td><td class="n">${c.media_ok ?? 0}${c.media_failed ? ` <span class="bad">(+${c.media_failed} failed)</span>` : ''}</td><td>${c.last_message_date ? formatDay(c.last_message_date) : ''}</td><td>${c.status ?? ''}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VK archive</title><style>${CSS}
table{border-collapse:collapse;width:100%;background:var(--card);border-radius:12px;overflow:hidden}th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left}td.n{text-align:right}th{font-size:13px;color:var(--muted)}.tag{font-size:11px;color:var(--muted)}.bad{color:#c0392b;font-size:12px}</style></head><body>
<header><h1>VK archive${me ? ` of ${escapeHtml(`${me.first_name} ${me.last_name}`)}` : ''}</h1><div class="meta">${chats.length} chats · <a href="stats.html">messaging stats</a> · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</div></header>
<main><table><thead><tr><th>Chat</th><th>Type</th><th>Messages</th><th>Media</th><th>Last message</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></main>
<footer>Exported with vk-chat-archiver</footer></body></html>`;
}
