import fs from 'node:fs';
import path from 'node:path';
import { sanitizeName } from './util.js';

export const CHAT_PEER_BASE = 2000000000;

/** Keeps a map of user/group ids to display names, fed from `extended=1` responses. */
export class NameBook {
  constructor() {
    this.users = new Map();
    this.groups = new Map();
  }

  absorb(response) {
    for (const p of response?.profiles ?? []) this.users.set(p.id, p);
    for (const g of response?.groups ?? []) this.groups.set(g.id, g);
  }

  has(id) {
    return id > 0 ? this.users.has(id) : this.groups.has(-id);
  }

  name(id) {
    if (id > 0) {
      const u = this.users.get(id);
      return u ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || `id${id}` : `id${id}`;
    }
    const g = this.groups.get(-id);
    return g ? g.name || `club${-id}` : `club${-id}`;
  }

  toJSON() {
    return {
      users: Object.fromEntries(this.users),
      groups: Object.fromEntries(this.groups),
    };
  }

  static fromJSON(obj) {
    const nb = new NameBook();
    for (const [k, v] of Object.entries(obj?.users ?? {})) nb.users.set(Number(k), v);
    for (const [k, v] of Object.entries(obj?.groups ?? {})) nb.groups.set(Number(k), v);
    return nb;
  }

  /** Fetch any ids we still don't know about. */
  async resolveMissing(api, ids) {
    const userIds = [...new Set(ids.filter((id) => id > 0 && !this.users.has(id)))];
    const groupIds = [...new Set(ids.filter((id) => id < 0 && !this.groups.has(-id)).map((id) => -id))];
    for (let i = 0; i < userIds.length; i += 500) {
      const res = await api.call('users.get', { user_ids: userIds.slice(i, i + 500), fields: 'screen_name,photo_100' });
      for (const u of res ?? []) this.users.set(u.id, u);
    }
    for (let i = 0; i < groupIds.length; i += 500) {
      try {
        const res = await api.call('groups.getById', { group_ids: groupIds.slice(i, i + 500), fields: 'screen_name,photo_100' });
        const list = Array.isArray(res) ? res : res?.groups ?? [];
        for (const g of list) this.groups.set(g.id, g);
      } catch (err) {
        // A banned/deleted community makes the whole batch fail; not worth dying for.
        if (api.log?.warn) api.log.warn(`groups.getById failed: ${err.message}`);
      }
    }
  }
}

/** Normalise a raw item of messages.getConversations into something we can work with. */
export function describePeer(item, names) {
  const conv = item.conversation ?? item;
  const peer = conv.peer;
  const id = peer.id;
  let kind;
  let title;
  if (peer.type === 'chat') {
    kind = 'chat';
    title = conv.chat_settings?.title || `Chat ${peer.local_id}`;
  } else if (peer.type === 'user') {
    kind = 'user';
    title = names.name(id);
  } else if (peer.type === 'group') {
    kind = 'group';
    title = names.name(id);
  } else {
    kind = peer.type || 'peer';
    title = `${kind} ${id}`;
  }
  return {
    peer_id: id,
    kind,
    title,
    members_count: conv.chat_settings?.members_count,
    last_message_id: conv.last_message_id,
    last_message_date: item.last_message?.date,
    is_archived: Boolean(conv.is_archived),
  };
}

/**
 * Directory for a peer. Uses `<kind>_<id>_<title>` but if a directory for this id
 * already exists (chat renamed since last run), reuse it so the archive stays resumable.
 */
export function peerDir(root, peer) {
  const prefix = `${peer.kind}_${peer.peer_id}_`;
  if (fs.existsSync(root)) {
    const existing = fs.readdirSync(root).find((d) => d.startsWith(prefix));
    if (existing) return path.join(root, existing);
  }
  return path.join(root, `${prefix}${sanitizeName(peer.title)}`);
}

/** List *all* conversations (regular + archived + message requests where supported). */
export async function listConversations(api, names, log) {
  const seen = new Map();
  const filters = ['all', 'archive', 'message_request'];
  for (const filter of filters) {
    let offset = 0;
    let total = null;
    for (;;) {
      let res;
      try {
        res = await api.call('messages.getConversations', {
          offset,
          count: 200,
          filter,
          extended: 1,
          fields: 'first_name,last_name,screen_name,photo_100,name,deactivated',
        });
      } catch (err) {
        if (filter !== 'all' && (err.code === 100 || err.code === 8)) {
          log.debug(`filter=${filter} not supported by this API version; skipping`);
          break;
        }
        throw err;
      }
      names.absorb(res);
      total ??= res.count;
      for (const item of res.items ?? []) {
        const p = describePeer(item, names);
        if (filter === 'archive') p.is_archived = true;
        if (!seen.has(p.peer_id)) seen.set(p.peer_id, p);
      }
      offset += res.items?.length ?? 0;
      if (!res.items?.length || offset >= total) break;
    }
  }
  return [...seen.values()];
}
