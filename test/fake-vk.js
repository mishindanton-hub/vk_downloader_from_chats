/**
 * A tiny fake of the VK API + a file host, good enough to exercise the archiver
 * end to end: pagination, retries, every attachment type, video.get, 404s, 917s.
 */
import http from 'node:http';

export const TOKEN = 'test-token';
export const ME = { id: 1, first_name: 'Me', last_name: 'Self' };

function photo(owner, id, base, { broken = false, flaky = false } = {}) {
  const name = broken ? 'missing.jpg' : flaky ? 'flaky.jpg' : `photo${owner}_${id}.jpg`;
  return {
    type: 'photo',
    photo: {
      id,
      owner_id: owner,
      sizes: [
        { type: 's', width: 75, height: 50, url: `${base}/files/small_${name}` },
        { type: 'x', width: 604, height: 400, url: `${base}/files/${name}` },
        { type: 'm', width: 130, height: 87, url: `${base}/files/m_${name}` },
      ],
    },
  };
}

export function buildMessages(base) {
  const user2 = [];
  for (let i = 1; i <= 450; i += 1) {
    const m = { id: i, date: 1400000000 + i * 3600, peer_id: 2, from_id: i % 2 ? 1 : 2, out: i % 2 ? 1 : 0, text: `msg ${i}`, attachments: [] };
    if (i % 10 === 0) m.attachments.push(photo(2, i, base));
    if (i === 5) m.attachments.push({ type: 'doc', doc: { id: 5, owner_id: 2, title: 'report.pdf', ext: 'pdf', size: 1234, url: `${base}/files/report.pdf` } });
    if (i === 7) m.attachments.push({ type: 'audio_message', audio_message: { id: 7, owner_id: 2, duration: 12, link_mp3: `${base}/files/voice7.mp3`, link_ogg: `${base}/files/voice7.ogg` } });
    if (i === 9) m.attachments.push({ type: 'sticker', sticker: { sticker_id: 9, product_id: 1, images: [{ url: `${base}/files/sticker9_64.png`, width: 64, height: 64 }, { url: `${base}/files/sticker9_512.png`, width: 512, height: 512 }] } });
    if (i === 11) m.attachments.push({ type: 'video', video: { id: 11, owner_id: 2, access_key: 'abc', title: 'Cat video', duration: 30, image: [{ url: `${base}/files/v11_thumb.jpg`, width: 320, height: 240 }] } });
    if (i === 13) m.attachments.push({ type: 'video', video: { id: 13, owner_id: 2, title: 'YouTube thing', duration: 60 } });
    if (i === 15) m.attachments.push({ type: 'video', video: { id: 15, owner_id: 2, title: 'Deleted video', duration: 60 } });
    if (i === 17) m.fwd_messages = [{ id: 0, date: 1390000000, from_id: 5, text: 'forwarded from a stranger', attachments: [photo(5, 1, base)] }];
    if (i === 19) m.reply_message = { id: 18, date: m.date - 100, from_id: 2, text: 'the original', attachments: [] };
    if (i === 21) m.attachments.push({ type: 'link', link: { url: 'https://example.com/x', title: 'Example' } });
    if (i === 23) m.attachments.push({ type: 'wall', wall: { id: 77, from_id: -100, owner_id: -100, text: 'a repost', attachments: [photo(-100, 3, base)], copy_history: [{ text: 'original post', attachments: [photo(-100, 4, base)] }] } });
    if (i === 25) m.attachments.push({ type: 'gift', gift: { id: 25, thumb_256: `${base}/files/gift25.png` } });
    if (i === 27) m.attachments.push({ type: 'graffiti', graffiti: { id: 27, owner_id: 2, url: `${base}/files/graffiti27.png` } });
    if (i === 29) m.attachments.push({ type: 'audio', audio: { id: 29, owner_id: 2, artist: 'Artist', title: 'Song', url: `${base}/files/song29.mp3` } });
    if (i === 31) m.attachments.push({ type: 'audio', audio: { id: 31, owner_id: 2, artist: 'Artist', title: 'HLS Song', url: `${base}/files/song31.m3u8` } });
    if (i === 33) m.attachments.push(photo(2, 33, base, { broken: true }));
    if (i === 35) m.attachments.push(photo(2, 35, base, { flaky: true }));
    if (i === 37) m.attachments.push({ type: 'market', market: { id: 37, owner_id: -100, title: 'Mug', thumb_photo: `${base}/files/market37.jpg` } });
    if (i === 39) m.attachments.push({ type: 'poll', poll: { id: 39, question: 'Tea or coffee?' } });
    if (i === 41) m.text = 'Hi [id2|Alice] check https://example.com/page?x=1 <script>alert(1)</script>';
    user2.push(m);
  }

  const chat = [
    { id: 1001, date: 1450000000, peer_id: 2000000001, from_id: 1, text: '', action: { type: 'chat_create', text: 'Test Chat' } },
    { id: 1002, date: 1450000100, peer_id: 2000000001, from_id: 1, text: '', action: { type: 'chat_invite_user', member_id: 2 } },
    { id: 1003, date: 1450000200, peer_id: 2000000001, from_id: 2, text: 'hello chat', attachments: [] },
    { id: 1004, date: 1450000300, peer_id: 2000000001, from_id: 6, text: 'from someone not in profiles', attachments: [] },
    { id: 1005, date: 1450000400, peer_id: 2000000001, from_id: 1, text: 'bye', action: { type: 'chat_kick_user', member_id: 1 } },
  ];
  const group = [
    { id: 2001, date: 1460000000, peer_id: -100, from_id: -100, text: 'newsletter', attachments: [photo(-100, 9, base)] },
    { id: 2002, date: 1460000100, peer_id: -100, from_id: 1, text: 'stop', attachments: [] },
  ];
  const archived = [{ id: 3001, date: 1470000000, peer_id: 4, from_id: 4, text: 'archived chat message', attachments: [] }];
  return { 2: user2, 2000000001: chat, '-100': group, 4: archived };
}

export function startFakeVk() {
  const state = { calls: [], flakyHits: 0, tooManyServed: false, filesServed: 0 };
  let base = '';
  let messages = {};
  const profiles = [ME, { id: 2, first_name: 'Alice', last_name: 'A' }, { id: 4, first_name: 'Dave', last_name: 'Archived' }];
  const groups = [{ id: 100, name: 'Some Public' }];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (obj) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(obj));
    };

    if (url.pathname.startsWith('/files/')) {
      const name = url.pathname.slice('/files/'.length);
      state.filesServed += 1;
      if (name === 'missing.jpg') {
        res.statusCode = 404;
        return res.end('nope');
      }
      if (name === 'flaky.jpg' && state.flakyHits++ === 0) {
        res.statusCode = 500;
        return res.end('boom');
      }
      const body = Buffer.alloc(name.length * 100, name.charCodeAt(0));
      res.setHeader('content-length', body.length);
      return res.end(body);
    }

    if (!url.pathname.startsWith('/method/')) {
      res.statusCode = 404;
      return res.end();
    }
    const method = url.pathname.slice('/method/'.length);
    let raw = '';
    for await (const c of req) raw += c;
    const p = Object.fromEntries(new URLSearchParams(raw));
    state.calls.push({ method, params: p });
    if (p.access_token !== TOKEN) return json({ error: { error_code: 5, error_msg: 'User authorization failed: invalid access_token.' } });

    switch (method) {
      case 'users.get': {
        if (!p.user_ids) return json({ response: [ME] });
        const ids = p.user_ids.split(',').map(Number);
        return json({ response: ids.map((id) => profiles.find((x) => x.id === id) ?? { id, first_name: `User${id}`, last_name: 'Resolved' }) });
      }
      case 'groups.getById': {
        const ids = p.group_ids.split(',').map(Number);
        return json({ response: ids.map((id) => groups.find((g) => g.id === id) ?? { id, name: `Group${id}` }) });
      }
      case 'messages.getConversations': {
        if (p.filter === 'message_request') return json({ error: { error_code: 100, error_msg: 'One of the parameters specified was missing or invalid: filter' } });
        let items;
        if (p.filter === 'archive') {
          items = [{ conversation: { peer: { id: 4, type: 'user', local_id: 4 } }, last_message: { date: 1470000000 } }];
        } else {
          items = [
            { conversation: { peer: { id: 2, type: 'user', local_id: 2 } }, last_message: { date: 1400000000 + 450 * 3600 } },
            { conversation: { peer: { id: 2000000001, type: 'chat', local_id: 1 }, chat_settings: { title: 'Test Chat', members_count: 2 } }, last_message: { date: 1450000400 } },
            { conversation: { peer: { id: -100, type: 'group', local_id: 100 } }, last_message: { date: 1460000100 } },
            { conversation: { peer: { id: 2000000002, type: 'chat', local_id: 2 }, chat_settings: { title: 'Kicked / from: chat' } }, last_message: { date: 1430000000 } },
          ];
        }
        const offset = Number(p.offset ?? 0);
        return json({ response: { count: items.length, items: items.slice(offset, offset + Number(p.count)), profiles, groups } });
      }
      case 'messages.getHistory': {
        if (!state.tooManyServed) {
          state.tooManyServed = true;
          return json({ error: { error_code: 6, error_msg: 'Too many requests per second' } });
        }
        if (p.peer_id === '2000000002') return json({ error: { error_code: 917, error_msg: "You don't have access to this chat" } });
        const all = messages[p.peer_id] ?? [];
        const newestFirst = [...all].reverse();
        const offset = Number(p.offset ?? 0);
        const count = Number(p.count ?? 20);
        return json({ response: { count: all.length, items: newestFirst.slice(offset, offset + count), profiles, groups } });
      }
      case 'video.get': {
        const wanted = p.videos.split(',');
        const items = [];
        for (const w of wanted) {
          const [owner, id, key] = w.split('_');
          if (id === '11') {
            if (key !== 'abc') continue;
            items.push({ id: 11, owner_id: Number(owner), title: 'Cat video (full)', files: { mp4_360: `${base}/files/v11_360.mp4`, mp4_720: `${base}/files/v11_720.mp4`, mp4_1080: `${base}/files/v11_1080.mp4` } });
          } else if (id === '13') {
            items.push({ id: 13, owner_id: Number(owner), title: 'YouTube thing', files: { external: 'https://www.youtube.com/watch?v=xyz' }, player: 'https://www.youtube.com/embed/xyz' });
          }
        }
        return json({ response: { count: items.length, items } });
      }
      default:
        return json({ error: { error_code: 3, error_msg: `Unknown method ${method}` } });
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      messages = buildMessages(base);
      resolve({ base, apiBase: `${base}/method/`, state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
