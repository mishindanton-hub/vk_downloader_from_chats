import fs from 'node:fs';
import path from 'node:path';
import { readMessages } from './history.js';
import { NameBook } from './peers.js';
import { CSS } from './render.js';
import { escapeHtml, formatDay, readJson } from './util.js';

const ATT_LABELS = { photo: 'Photos', video: 'Videos', audio_message: 'Voice messages', doc: 'Documents', sticker: 'Stickers', audio: 'Music', link: 'Links', wall: 'Reposts', gift: 'Gifts', graffiti: 'Graffiti' };
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Walk every chat directory in the archive and compute messaging statistics
 * from messages.jsonl (the source of truth). Pure disk work, no network.
 */
export function computeStats(out) {
  const names = NameBook.fromJSON(readJson(path.join(out, 'names.json'), null));
  const me = readJson(path.join(out, 'me.json'), null) ?? {};
  const myId = me.id;
  const chats = [];
  const years = new Map();
  const months = new Map();
  const hours = new Array(24).fill(0);
  const weekdays = new Array(7).fill(0);
  const days = new Map();
  const attachments = {};
  const senders = new Map();
  let total = 0;
  let sent = 0;
  let words = 0;
  let first = Infinity;
  let last = 0;

  const bump = (map, key, isMine) => {
    const e = map.get(key) ?? { total: 0, sent: 0 };
    e.total += 1;
    if (isMine) e.sent += 1;
    map.set(key, e);
  };

  for (const d of fs.readdirSync(out).sort()) {
    const dir = path.join(out, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    const state = readJson(path.join(dir, 'state.json'), null);
    if (!state?.peer_id || !fs.existsSync(path.join(dir, 'messages.jsonl'))) continue;
    const messages = readMessages(path.join(dir, 'messages.jsonl'));
    if (!messages.length) continue;
    const c = {
      peer_id: state.peer_id,
      kind: state.kind ?? d.split('_')[0],
      title: state.title ?? names.name(state.peer_id),
      dir: d,
      total: messages.length,
      sent: 0,
      words: 0,
      first: messages[0].date,
      last: messages[messages.length - 1].date,
      days: new Set(),
      senders: new Map(),
      attachments: {},
    };
    for (const m of messages) {
      const mine = m.from_id === myId || (myId === undefined && m.out === 1);
      const dt = new Date(m.date * 1000);
      const day = formatDay(m.date);
      const w = m.text ? m.text.trim().split(/\s+/).filter(Boolean).length : 0;
      c.words += w;
      words += w;
      if (mine) { c.sent += 1; sent += 1; }
      c.days.add(day);
      c.senders.set(m.from_id, (c.senders.get(m.from_id) ?? 0) + 1);
      bump(years, dt.getFullYear(), mine);
      bump(months, `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`, mine);
      hours[dt.getHours()] += 1;
      weekdays[(dt.getDay() + 6) % 7] += 1;
      days.set(day, (days.get(day) ?? 0) + 1);
      if (!mine && m.from_id) senders.set(m.from_id, (senders.get(m.from_id) ?? 0) + 1);
      for (const a of m.attachments ?? []) {
        attachments[a.type] = (attachments[a.type] ?? 0) + 1;
        c.attachments[a.type] = (c.attachments[a.type] ?? 0) + 1;
      }
    }
    total += messages.length;
    first = Math.min(first, c.first);
    last = Math.max(last, c.last);
    c.days_active = c.days.size;
    delete c.days;
    c.top_senders = [...c.senders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => ({ id, name: id === myId ? 'you' : names.name(id), n }));
    delete c.senders;
    chats.push(c);
  }

  // Busiest day and longest streak of consecutive days with at least one message.
  let busiest = null;
  for (const [day, n] of days) if (!busiest || n > busiest.n) busiest = { day, n };
  const sortedDays = [...days.keys()].sort();
  let streak = 0;
  let best = { len: 0, from: null, to: null };
  let prev = null;
  for (const day of sortedDays) {
    const t = Date.parse(`${day}T00:00:00Z`);
    streak = prev !== null && t - prev === 86400000 ? streak + 1 : 1;
    if (streak > best.len) best = { len: streak, from: sortedDays[sortedDays.indexOf(day) - streak + 1], to: day };
    prev = t;
  }

  const byTotal = [...chats].sort((a, b) => b.total - a.total);
  return {
    me,
    generated_at: new Date().toISOString(),
    totals: {
      chats: chats.length,
      messages: total,
      sent,
      received: total - sent,
      words,
      first: Number.isFinite(first) ? first : null,
      last: last || null,
      days_active: days.size,
      media: Object.values(attachments).reduce((a, b) => a + b, 0),
    },
    attachments,
    busiest_day: busiest,
    longest_streak: best,
    years: [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, v]) => ({ year, ...v })),
    months: [...months.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([month, v]) => ({ month, ...v })),
    hours,
    weekdays,
    top_chats: byTotal.slice(0, 25),
    top_people: [...senders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([id, n]) => ({ id, name: names.name(id), n })),
    group_chats: byTotal.filter((c) => c.kind === 'chat').slice(0, 10),
    chats: byTotal,
  };
}

export function writeStats(out, log) {
  const stats = computeStats(out);
  fs.writeFileSync(path.join(out, 'stats.json'), JSON.stringify(stripHeavy(stats), null, 1));
  fs.writeFileSync(path.join(out, 'stats.html'), renderStatsHtml(stats));
  log?.info?.(`Stats: ${stats.totals.messages} messages in ${stats.totals.chats} chats, ${stats.totals.sent} sent by you. See ${path.join(out, 'stats.html')}`);
  return stats;
}

function stripHeavy(stats) {
  return { ...stats, chats: stats.chats.map(({ top_senders, ...c }) => c), top_chats: undefined, group_chats: undefined };
}

// ---------- rendering ----------

const STATS_CSS = `
:root{--s1:#2a78d6;--s2:#eb6834;--grid:#e5e7eb}
@media (prefers-color-scheme:dark){:root{--s1:#3987e5;--s2:#d95926;--grid:#2b303b}}
main{max-width:1000px}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin:14px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.tile .l{font-size:12px;color:var(--muted)}.tile .v{font-size:24px;font-weight:600;margin-top:2px}.tile .s{font-size:12px;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:14px 0}
.card h2{margin:0 0 2px;font-size:16px}.card .sub{font-size:13px;color:var(--muted);margin-bottom:10px}
.legend{display:flex;gap:16px;font-size:13px;color:var(--muted);margin-bottom:8px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
svg{display:block;max-width:100%;height:auto;font:12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
svg text{fill:var(--txt)}svg .mut{fill:var(--muted)}svg .grid{stroke:var(--grid);stroke-width:1}
svg .s1{fill:var(--s1)}svg .s2{fill:var(--s2)}svg .line{fill:none;stroke:var(--s1);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
svg .area{fill:var(--s1);opacity:.1}svg .dot{fill:var(--s1);stroke:var(--card);stroke-width:2}
svg rect.s1:hover,svg rect.s2:hover,svg .dot:hover{opacity:.75}
details{margin-top:8px;font-size:13px}summary{cursor:pointer;color:var(--muted)}
table{border-collapse:collapse;width:100%;margin-top:8px}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;font-size:13px}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}th{color:var(--muted);font-weight:500}
`;

const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '');

export function renderStatsHtml(s) {
  const t = s.totals;
  const who = s.me?.first_name ? `${s.me.first_name} ${s.me.last_name ?? ''}`.trim() : 'you';
  const span = t.first && t.last ? `${formatDay(t.first)} → ${formatDay(t.last)}` : '';
  const yearsSpan = t.first && t.last ? ((t.last - t.first) / 31557600).toFixed(1) : null;

  const tiles = [
    ['Messages', fmt(t.messages), `${fmt(t.sent)} sent by you (${pct(t.sent, t.messages)}), ${fmt(t.received)} received`],
    ['Chats', fmt(t.chats), `${s.chats.filter((c) => c.kind === 'user').length} people, ${s.chats.filter((c) => c.kind === 'chat').length} group chats, ${s.chats.filter((c) => c.kind === 'group').length} communities`],
    ['Years of history', yearsSpan ?? '—', span],
    ['Days with messages', fmt(t.days_active), s.longest_streak.len ? `longest streak ${s.longest_streak.len} days (${s.longest_streak.from} → ${s.longest_streak.to})` : ''],
    ['Busiest day', s.busiest_day ? fmt(s.busiest_day.n) : '—', s.busiest_day ? `messages on ${s.busiest_day.day}` : ''],
    ['Words typed', fmt(t.words), `${t.messages ? (t.words / t.messages).toFixed(1) : 0} per message on average`],
    ['Attachments', fmt(t.media), Object.entries(s.attachments).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${fmt(n)} ${(ATT_LABELS[k] ?? k).toLowerCase()}`).join(', ')],
  ]
    .map(([l, v, sub]) => `<div class="tile"><div class="l">${escapeHtml(l)}</div><div class="v">${escapeHtml(v)}</div><div class="s">${escapeHtml(sub)}</div></div>`)
    .join('');

  const legend = `<div class="legend"><span><i style="background:var(--s1)"></i>sent by you</span><span><i style="background:var(--s2)"></i>received</span></div>`;

  const topChats = hbars(
    s.top_chats.map((c) => ({ label: c.title, href: `${encodeURI(c.dir)}/messages.html`, a: c.sent, b: c.total - c.sent, total: c.total })),
  );
  const topTable = tableOf(
    ['Chat', 'Type', 'Messages', 'You', 'Them', 'Your share', 'Days active', 'First', 'Last'],
    s.top_chats.map((c) => [link(c), c.kind, fmt(c.total), fmt(c.sent), fmt(c.total - c.sent), pct(c.sent, c.total), fmt(c.days_active), formatDay(c.first), formatDay(c.last)]),
    [2, 3, 4, 5, 6],
  );

  const yearCols = columns(s.years.map((y) => ({ label: String(y.year), a: y.sent, b: y.total - y.sent, total: y.total })), { stacked: true });
  const yearTable = tableOf(['Year', 'Messages', 'You', 'Them'], s.years.map((y) => [String(y.year), fmt(y.total), fmt(y.sent), fmt(y.total - y.sent)]), [1, 2, 3]);

  const monthLine = lineChart(s.months.map((m) => ({ label: m.month, v: m.total })));
  const hourCols = columns(s.hours.map((n, h) => ({ label: String(h).padStart(2, '0'), total: n })), { every: 3 });
  const dayCols = columns(s.weekdays.map((n, i) => ({ label: WEEKDAYS[i], total: n })), {});

  const people = hbars(s.top_people.map((p) => ({ label: p.name, total: p.n, single: true })), { single: true });

  const groups = s.group_chats.length
    ? tableOf(
        ['Group chat', 'Messages', 'You', 'Most active'],
        s.group_chats.map((c) => [link(c), fmt(c.total), `${fmt(c.sent)} (${pct(c.sent, c.total)})`, c.top_senders.map((p) => `${escapeHtml(p.name)} ${fmt(p.n)}`).join(', ')]),
        [1, 2],
        true,
      )
    : '<p class="sub">No group chats.</p>';

  const attRows = Object.entries(s.attachments).sort((a, b) => b[1] - a[1]).map(([k, n]) => [ATT_LABELS[k] ?? k, fmt(n)]);
  const attTable = tableOf(['Type', 'Count'], attRows, [1]);

  const allChats = tableOf(
    ['Chat', 'Type', 'Messages', 'You', 'Them', 'Words', 'First', 'Last'],
    s.chats.map((c) => [link(c), c.kind, fmt(c.total), fmt(c.sent), fmt(c.total - c.sent), fmt(c.words), formatDay(c.first), formatDay(c.last)]),
    [2, 3, 4, 5],
  );

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VK stats</title><style>${CSS}${STATS_CSS}</style></head><body>
<header><h1>Messaging stats${s.me?.first_name ? ` · ${escapeHtml(who)}` : ''}</h1><div class="meta">${fmt(t.messages)} messages in ${fmt(t.chats)} chats · <a href="index.html">all chats</a> · generated ${s.generated_at.slice(0, 16).replace('T', ' ')}</div></header>
<main>
<div class="tiles">${tiles}</div>

<section class="card"><h2>Who you message most</h2><div class="sub">Top ${s.top_chats.length} chats by number of messages, split into what you sent and what you received.</div>${legend}${topChats}<details><summary>Table</summary>${topTable}</details></section>

<section class="card"><h2>Messages per year</h2><div class="sub">All chats together.</div>${legend}${yearCols}<details><summary>Table</summary>${yearTable}</details></section>

<section class="card"><h2>Activity over time</h2><div class="sub">Messages per month, all chats. Hover a point for the value.</div>${monthLine}</section>

<section class="card"><h2>Time of day</h2><div class="sub">When messages were written (hours in this computer's time zone).</div>${hourCols}</section>

<section class="card"><h2>Day of the week</h2>${dayCols}</section>

<section class="card"><h2>People who wrote to you most</h2><div class="sub">Counted across every chat, including group chats.</div>${people}</section>

<section class="card"><h2>Group chats</h2>${groups}</section>

<section class="card"><h2>Attachments</h2><div class="sub">Everything attached to messages, including forwarded ones counted once per message.</div>${attTable}</section>

<section class="card"><h2>Every chat</h2><details><summary>Show all ${s.chats.length} chats</summary>${allChats}</details></section>
</main>
<footer>Computed from the archived messages · stats.json holds the raw numbers</footer></body></html>`;
}

function link(c) {
  return `<a href="${encodeURI(c.dir)}/messages.html">${escapeHtml(c.title)}</a>`;
}

function tableOf(head, rows, numericCols = [], rawHtml = false) {
  const th = head.map((h, i) => `<th${numericCols.includes(i) ? ' class="n"' : ''}>${escapeHtml(h)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${r.map((cell, i) => `<td${numericCols.includes(i) ? ' class="n"' : ''}>${i === 0 || rawHtml ? cell : escapeHtml(String(cell))}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Horizontal bars, optionally stacked (a = sent, b = received). Value at the tip. */
function hbars(rows, { single = false } = {}) {
  if (!rows.length) return '<p class="sub">No data.</p>';
  const W = 960;
  const labelW = 220;
  const rowH = 26;
  const barH = 16;
  const H = rows.length * rowH + 8;
  const max = Math.max(...rows.map((r) => r.total), 1);
  const plotW = W - labelW - 90;
  const x = (v) => (v / max) * plotW;
  const parts = rows.map((r, i) => {
    const y = 4 + i * rowH + (rowH - barH) / 2;
    const label = r.label.length > 30 ? `${r.label.slice(0, 29)}…` : r.label;
    const text = `<text x="${labelW - 10}" y="${y + barH - 4}" text-anchor="end">${r.href ? `<a href="${r.href}">${escapeHtml(label)}</a>` : escapeHtml(label)}</text>`;
    let bars;
    if (single) {
      bars = `<rect class="s1" x="${labelW}" y="${y}" width="${x(r.total).toFixed(1)}" height="${barH}" rx="4"><title>${escapeHtml(r.label)}: ${fmt(r.total)}</title></rect>`;
    } else {
      const wa = x(r.a);
      const wb = Math.max(0, x(r.b) - 2);
      bars = `<rect class="s1" x="${labelW}" y="${y}" width="${wa.toFixed(1)}" height="${barH}"><title>${escapeHtml(r.label)}: you ${fmt(r.a)}</title></rect><rect class="s2" x="${(labelW + wa + 2).toFixed(1)}" y="${y}" width="${wb.toFixed(1)}" height="${barH}" rx="4"><title>${escapeHtml(r.label)}: them ${fmt(r.b)}</title></rect>`;
    }
    const val = `<text class="mut" x="${(labelW + x(r.total) + 8).toFixed(1)}" y="${y + barH - 4}">${fmt(r.total)}</text>`;
    return text + bars + val;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="bar chart">${parts.join('')}</svg>`;
}

/** Vertical columns; stacked when rows carry a/b. `every` thins the x labels. */
function columns(rows, { stacked = false, every = 1 } = {}) {
  if (!rows.length || !rows.some((r) => r.total)) return '<p class="sub">No data.</p>';
  const W = 960;
  const H = 240;
  const padL = 56;
  const padB = 28;
  const padT = 12;
  const plotH = H - padT - padB;
  const max = Math.max(...rows.map((r) => r.total), 1);
  const niceMax = niceCeil(max);
  const slot = (W - padL - 10) / rows.length;
  const bw = Math.min(24, slot * 0.7);
  const y = (v) => padT + plotH - (v / niceMax) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(niceMax * f));
  const grid = ticks.map((v) => `<line class="grid" x1="${padL}" x2="${W - 10}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="mut" x="${padL - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${fmt(v)}</text>`).join('');
  const cols = rows.map((r, i) => {
    const cx = padL + slot * i + slot / 2;
    const x0 = (cx - bw / 2).toFixed(1);
    let rect;
    if (stacked) {
      const ha = (r.a / niceMax) * plotH;
      const hb = Math.max(0, (r.b / niceMax) * plotH - 2);
      rect = `<rect class="s1" x="${x0}" y="${(padT + plotH - ha).toFixed(1)}" width="${bw.toFixed(1)}" height="${ha.toFixed(1)}"><title>${escapeHtml(r.label)}: you ${fmt(r.a)}</title></rect><rect class="s2" x="${x0}" y="${(padT + plotH - ha - 2 - hb).toFixed(1)}" width="${bw.toFixed(1)}" height="${hb.toFixed(1)}" rx="4"><title>${escapeHtml(r.label)}: them ${fmt(r.b)}</title></rect>`;
    } else {
      rect = `<rect class="s1" x="${x0}" y="${y(r.total).toFixed(1)}" width="${bw.toFixed(1)}" height="${(padT + plotH - y(r.total)).toFixed(1)}" rx="4"><title>${escapeHtml(r.label)}: ${fmt(r.total)}</title></rect>`;
    }
    const lab = i % every === 0 ? `<text class="mut" x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle">${escapeHtml(r.label)}</text>` : '';
    return rect + lab;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="column chart">${grid}${cols.join('')}</svg>`;
}

/** Single-series line with area wash and hoverable end/peak dots. */
function lineChart(points) {
  if (points.length < 2) return '<p class="sub">Not enough data.</p>';
  const W = 960;
  const H = 220;
  const padL = 56;
  const padB = 28;
  const padT = 12;
  const plotW = W - padL - 10;
  const plotH = H - padT - padB;
  const max = Math.max(...points.map((p) => p.v), 1);
  const niceMax = niceCeil(max);
  const x = (i) => padL + (i / (points.length - 1)) * plotW;
  const y = (v) => padT + plotH - (v / niceMax) * plotH;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const area = `${d}L${x(points.length - 1).toFixed(1)},${(padT + plotH).toFixed(1)}L${padL},${(padT + plotH).toFixed(1)}Z`;
  const ticks = [0, 0.5, 1].map((f) => Math.round(niceMax * f));
  const grid = ticks.map((v) => `<line class="grid" x1="${padL}" x2="${W - 10}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="mut" x="${padL - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${fmt(v)}</text>`).join('');
  const labelEvery = Math.max(1, Math.ceil(points.length / 12));
  const labels = points.map((p, i) => (i % labelEvery === 0 ? `<text class="mut" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${escapeHtml(p.label)}</text>` : '')).join('');
  const peak = points.reduce((b, p, i) => (p.v > points[b].v ? i : b), 0);
  const dots = points.map((p, i) => `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="${i === peak ? 5 : 4}" opacity="${i === peak || i === points.length - 1 ? 1 : 0}"><title>${escapeHtml(p.label)}: ${fmt(p.v)}</title></circle>`).join('');
  const peakLabel = `<text x="${x(peak).toFixed(1)}" y="${(y(points[peak].v) - 10).toFixed(1)}" text-anchor="middle">${escapeHtml(points[peak].label)}: ${fmt(points[peak].v)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="line chart"><style>.dot:hover{opacity:1!important}</style>${grid}<path class="area" d="${area}"/><path class="line" d="${d}"/>${dots}${peakLabel}${labels}</svg>`;
}

function niceCeil(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return n * p;
}
