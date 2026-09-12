import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { VkApi } from './api.js';
import { rerender, runArchive } from './archive.js';
import { APPS, buildAuthUrl, parseTokenInput } from './auth.js';
import { CONFIG_FILE, loadConfig, resolveToken, saveConfig } from './config.js';
import { NameBook, listConversations } from './peers.js';
import { formatDate, makeLogger } from './util.js';

const HELP = `vk-archive: offload all your VK conversations (text + media) to disk.

Usage:
  vk-archive auth [--app kate|android|iphone|vkadmin] [--app-id N]
        Print the login URL, then paste the resulting URL back to store the token.
  vk-archive whoami
        Check the stored token.
  vk-archive chats
        List every conversation the token can see.
  vk-archive run [options]
        Archive everything (resumable; re-run to continue or to pick up new media).
  vk-archive render [--out DIR]
        Rebuild HTML/JSON/TXT from already-downloaded data, no network needed.

Options for run:
  --out DIR              output directory (default ./vk-archive)
  --peer ID[,ID...]      only these peer ids (user id, -group id, or 2000000000+chat id)
  --text-only            fetch history only, download no media
  --no-video             skip videos            --no-photos    skip photos
  --no-docs              skip documents         --no-voice     skip voice messages
  --no-stickers          skip stickers          --no-music     skip music files
  --skip-groups          skip conversations with communities (newsletters, bots)
  --max-video-quality N  highest mp4 height to download (default 2160, e.g. 720)
  --concurrency N        parallel downloads (default 4)
  --retry-failed         retry media that previously failed with 403/404
  --token TOKEN          use this token instead of the stored one (or VK_TOKEN env)
  --api-version V        VK API version (default 5.131)
  --domain vk.com|vk.ru  which VK host to talk to (default vk.com, falls back to vk.ru automatically)
  -v, --verbose          chatty logging
`;

const OPTIONS = {
  out: { type: 'string' },
  peer: { type: 'string' },
  app: { type: 'string' },
  'app-id': { type: 'string' },
  token: { type: 'string' },
  'api-version': { type: 'string' },
  'api-base': { type: 'string' },
  domain: { type: 'string' },
  'max-video-quality': { type: 'string' },
  concurrency: { type: 'string' },
  'text-only': { type: 'boolean' },
  'no-video': { type: 'boolean' },
  'no-photos': { type: 'boolean' },
  'no-docs': { type: 'boolean' },
  'no-voice': { type: 'boolean' },
  'no-stickers': { type: 'boolean' },
  'no-music': { type: 'boolean' },
  'skip-groups': { type: 'boolean' },
  'retry-failed': { type: 'boolean' },
  verbose: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
};

export async function main(argv) {
  const { values: o, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const cmd = positionals[0] ?? 'help';
  const log = makeLogger(Boolean(o.verbose));
  if (o.help || cmd === 'help') {
    console.log(HELP);
    return 0;
  }

  if (cmd === 'auth') return cmdAuth(o, log);
  if (cmd === 'render') {
    rerender({ out: path.resolve(o.out ?? 'vk-archive'), log });
    return 0;
  }

  const api = makeApi(o, log);
  if (cmd === 'whoami') {
    const [me] = await api.call('users.get', { fields: 'screen_name' });
    log.info(`Token works. You are ${me.first_name} ${me.last_name} (id${me.id}${me.screen_name ? `, @${me.screen_name}` : ''}).`);
    return 0;
  }
  if (cmd === 'chats') {
    const names = new NameBook();
    const peers = await listConversations(api, names, log);
    peers.sort((a, b) => (b.last_message_date ?? 0) - (a.last_message_date ?? 0));
    for (const p of peers) {
      log.info(`${String(p.peer_id).padStart(11)}  ${p.kind.padEnd(5)}  ${p.last_message_date ? formatDate(p.last_message_date).slice(0, 10) : '          '}  ${p.title}${p.is_archived ? '  [archived]' : ''}`);
    }
    log.info(`\n${peers.length} conversations`);
    return 0;
  }
  if (cmd === 'run') {
    const flags = {
      textOnly: o['text-only'],
      noVideo: o['no-video'],
      noPhotos: o['no-photos'],
      noDocs: o['no-docs'],
      noVoice: o['no-voice'],
      noStickers: o['no-stickers'],
      noMusic: o['no-music'],
      skipGroups: o['skip-groups'],
      retryFailed: o['retry-failed'],
      maxVideoQuality: o['max-video-quality'] ? Number(o['max-video-quality']) : undefined,
    };
    await runArchive({
      api,
      out: path.resolve(o.out ?? 'vk-archive'),
      log,
      peerFilter: o.peer ? o.peer.split(',').map((s) => s.trim()).filter(Boolean) : null,
      flags,
      concurrency: o.concurrency ? Number(o.concurrency) : 4,
      userAgent: api.userAgent,
    });
    return 0;
  }
  console.error(`Unknown command "${cmd}".\n\n${HELP}`);
  return 2;
}

function makeApi(o, log) {
  const { token, source, app } = resolveToken(o.token);
  if (!token) {
    throw new Error(`No access token. Run "vk-archive auth" first (or pass --token / set VK_TOKEN).`);
  }
  log.debug(`using token from ${source}`);
  const appInfo = APPS[app ?? 'kate'];
  return new VkApi({
    token,
    version: o['api-version'] ?? '5.131',
    domain: o.domain ?? process.env.VK_DOMAIN ?? 'vk.com',
    baseUrl: o['api-base'] ?? process.env.VK_API_BASE,
    userAgent: appInfo?.userAgent,
    log,
  });
}

async function cmdAuth(o, log) {
  const app = o.app ?? 'kate';
  const appId = o['app-id'] ? Number(o['app-id']) : undefined;
  const domain = o.domain ?? process.env.VK_DOMAIN ?? 'vk.com';
  const url = buildAuthUrl({ app, appId, apiVersion: o['api-version'] ?? '5.131', domain });
  log.info(`\n1. Open this URL in a browser where you are logged in to vk.com:\n\n   ${url}\n`);
  log.info(`2. Log in / confirm access for "${appId ? `app ${appId}` : APPS[app].name}".`);
  log.info(`3. You will land on a blank page. Copy the ENTIRE address from the address bar`);
  log.info(`   (it looks like https://oauth.${domain}/blank.html#access_token=...&user_id=...) and paste it below.`);
  log.info(`   If the page does not open at all, run again with: --domain ${domain === 'vk.com' ? 'vk.ru' : 'vk.com'}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question('Paste URL here: ', resolve));
  rl.close();
  const parsed = parseTokenInput(answer);
  const cfg = loadConfig();
  Object.assign(cfg, { access_token: parsed.access_token, user_id: parsed.user_id, app: appId ? undefined : app, app_id: appId ?? APPS[app].id, saved_at: new Date().toISOString() });
  saveConfig(cfg);
  log.info(`\nToken saved to ${CONFIG_FILE}. Now run: vk-archive whoami`);
  return 0;
}
