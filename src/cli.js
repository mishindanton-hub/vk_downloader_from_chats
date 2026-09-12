import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { VkApi } from './api.js';
import { rerender, runArchive } from './archive.js';
import { assetPath, readAsset } from './assets.js';
import { APPS, buildAuthUrl, parseTokenInput } from './auth.js';
import { CONFIG_FILE, loadConfig, resolveToken, saveConfig } from './config.js';
import { runEasy } from './easy.js';
import { startGui } from './gui.js';
import { importExport } from './import.js';
import { NameBook, listConversations } from './peers.js';
import { writeStats } from './stats.js';
import { formatDate, makeLogger, sleep } from './util.js';

const HELP = `vk-archive: offload all your VK conversations (text + media) to disk.

Usage:
  vk-archive gui [--out DIR] [--downloads DIR] [--port N]
        The point-and-click interface the launchers open: a local page in your browser
        with the steps, progress, and the finished archive.
  vk-archive easy [--out DIR] [--downloads DIR]
        The one-button flow the launchers use: asks where to save, opens VK in the
        browser with the export script on the clipboard, imports the exported files
        as they land in Downloads, then downloads all media and opens the result.
  vk-archive auth [--app kate|android|iphone|vkme|vkadmin] [--app-id N]
        Print the login URL, then paste the resulting URL back to store the token.
  vk-archive whoami
        Check the stored token.
  vk-archive diagnose
        Try the token against both hosts, several API versions and user agents
        and report which combination VK accepts (use when whoami fails).
  vk-archive chats
        List every conversation the token can see.
  vk-archive run [options]
        Archive everything (resumable; re-run to continue or to pick up new media).
  vk-archive render [--out DIR]
        Rebuild HTML/JSON/TXT from already-downloaded data, no network needed.
  vk-archive stats [--out DIR]
        Compute messaging statistics (who, how many, when) into stats.html / stats.json.

Without a token (browser route, when VK refuses the token):
  vk-archive browser
        Show how to export all chats from the VK web page's console
        (copies browser-export.js to the clipboard on macOS).
  vk-archive import FILE...
        Import the vk-export-*.json files saved by that script.
  vk-archive run --offline [options]
        Download all media and render, using only the imported data.

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
  --no-user-agent        do not impersonate the app the token was issued for
  --offline              no API calls: use data from "import" (browser export)
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
  'no-user-agent': { type: 'boolean' },
  offline: { type: 'boolean' },
  downloads: { type: 'string' },
  port: { type: 'string' },
  'no-open': { type: 'boolean' },
  verbose: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
};

export async function main(argv) {
  const { values: o, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  // No command (a double-clicked app or executable) opens the point-and-click interface.
  const cmd = positionals[0] ?? (o.help ? 'help' : 'gui');
  const log = makeLogger(Boolean(o.verbose));
  if (o.help || cmd === 'help') {
    console.log(HELP);
    return 0;
  }

  if (cmd === 'auth') return cmdAuth(o, log);
  if (cmd === 'diagnose') return cmdDiagnose(o, log);
  if (cmd === 'render') {
    rerender({ out: path.resolve(o.out ?? 'vk-archive'), log });
    return 0;
  }
  if (cmd === 'stats') {
    writeStats(path.resolve(o.out ?? loadConfig().out ?? 'vk-archive'), log);
    return 0;
  }
  if (cmd === 'browser') return cmdBrowser(log);
  if (cmd === 'gui') {
    await startGui({ out: o.out, downloads: o.downloads, port: o.port ? Number(o.port) : 0, open: !o['no-open'], flags: runFlags(o), concurrency: o.concurrency ? Number(o.concurrency) : 4, log });
    // Keep serving until the page's Quit button (or Ctrl+C).
    await new Promise(() => {});
    return 0;
  }
  if (cmd === 'easy') {
    return runEasy({
      out: o.out,
      downloads: o.downloads,
      log,
      flags: runFlags(o),
      concurrency: o.concurrency ? Number(o.concurrency) : 4,
    });
  }
  if (cmd === 'import') {
    importExport({ files: positionals.slice(1), out: path.resolve(o.out ?? 'vk-archive'), log });
    log.info(`\nNow run: node bin/vk-archive.js run --offline`);
    return 0;
  }

  const api = cmd === 'run' && o.offline ? null : makeApi(o, log);
  if (cmd === 'whoami') {
    log.info(`Checking the token at ${api.baseUrl} ...`);
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
    const flags = runFlags(o);
    await runArchive({
      api,
      out: path.resolve(o.out ?? 'vk-archive'),
      log,
      peerFilter: o.peer ? o.peer.split(',').map((s) => s.trim()).filter(Boolean) : null,
      flags,
      concurrency: o.concurrency ? Number(o.concurrency) : 4,
      userAgent: api?.userAgent,
    });
    return 0;
  }
  console.error(`Unknown command "${cmd}".\n\n${HELP}`);
  return 2;
}

function runFlags(o) {
  return {
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
}

function makeApi(o, log) {
  const { token, source, app, domain } = resolveToken(o.token);
  if (!token) {
    throw new Error(`No access token. Run "vk-archive auth" first (or pass --token / set VK_TOKEN).`);
  }
  log.debug(`using token from ${source}`);
  const appInfo = APPS[app ?? 'kate'];
  return new VkApi({
    token,
    version: o['api-version'] ?? '5.131',
    domain: o.domain ?? process.env.VK_DOMAIN ?? domain ?? 'vk.com',
    baseUrl: o['api-base'] ?? process.env.VK_API_BASE,
    userAgent: o['no-user-agent'] ? undefined : appInfo?.userAgent,
    log,
  });
}

/**
 * Try users.get with the stored token across hosts, API versions and user agents,
 * without retries, and print what VK answers. Meant for the case where whoami fails
 * with something like [9] Flood control or [5] authorization failed.
 */
async function cmdDiagnose(o, log) {
  const { token, app, domain } = resolveToken(o.token);
  if (!token) throw new Error(`No access token. Run "vk-archive auth" first.`);
  const appInfo = APPS[app ?? 'kate'];
  const domains = o.domain ? [o.domain] : [domain ?? 'vk.ru', domain === 'vk.com' ? 'vk.ru' : 'vk.com'].filter((d, i, a) => a.indexOf(d) === i);
  const versions = o['api-version'] ? [o['api-version']] : ['5.131', '5.199', '5.288'];
  const agents = [
    { label: `${appInfo?.name ?? 'app'} user-agent`, ua: appInfo?.userAgent, flag: '' },
    { label: 'no user-agent', ua: undefined, flag: ' --no-user-agent' },
  ];
  const quiet = { info() {}, warn() {}, debug() {}, error() {} };
  const results = [];
  log.info(`Testing the stored token (${appInfo?.name ?? 'custom app'}) with users.get, one call per combination...\n`);
  for (const d of domains) {
    for (const v of versions) {
      for (const a of agents) {
        const api = new VkApi({ token, version: v, baseUrl: `https://api.${d}/method/`, userAgent: a.ua, maxRetries: 0, minInterval: 0, timeoutMs: 15000, log: quiet });
        let outcome;
        let ok = false;
        try {
          const [me] = await api.call('users.get');
          outcome = `OK  (${me.first_name} ${me.last_name})`;
          ok = true;
        } catch (err) {
          outcome = err.code ? `[${err.code}] ${err.body?.error_msg}` : `network: ${err.message}`;
        }
        log.info(`  api.${d.padEnd(6)}  v${v}  ${a.label.padEnd(24)}  ${outcome}`);
        results.push({ domain: d, version: v, agent: a, ok, outcome });
        await sleep(1200);
      }
    }
  }
  const good = results.find((r) => r.ok);
  log.info('');
  if (good) {
    const flags = `--domain ${good.domain} --api-version ${good.version}${good.agent.flag}`;
    log.info(`VK accepts the token with: ${flags}`);
    log.info(`Run the archive with:\n\n  node bin/vk-archive.js run ${flags}\n`);
    return 0;
  }
  const codes = new Set(results.map((r) => r.outcome.slice(0, 4)));
  if (codes.has('[9] ')) {
    log.info('Every combination answers "Flood control". VK is throttling this token, not the network.');
    log.info('  1. Close every other Terminal window that may still be running the tool.');
    log.info('  2. Wait 15-30 minutes without calling the API, then run "diagnose" again.');
    log.info('  3. If it persists, get a token from a different official app and try again:');
    log.info('       node bin/vk-archive.js auth --app android      (or --app iphone, --app vkadmin, --app vkme)');
  } else if (codes.has('[5] ')) {
    log.info('VK does not accept the token any more. Log in again: node bin/vk-archive.js auth');
  } else {
    log.info('No combination worked; see the answers above.');
  }
  return 1;
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
  const savedDomain = parsed.domain ?? domain;
  Object.assign(cfg, {
    access_token: parsed.access_token,
    user_id: parsed.user_id,
    app: appId ? undefined : app,
    app_id: appId ?? APPS[app].id,
    domain: savedDomain,
    saved_at: new Date().toISOString(),
  });
  saveConfig(cfg);
  if (savedDomain !== domain) log.info(`\nVK sent you to ${savedDomain}, so the API will be used at api.${savedDomain}.`);
  log.info(`\nToken saved to ${CONFIG_FILE}. Now run: vk-archive whoami`);
  return 0;
}


/** Explain the browser route and put the console script on the clipboard where we can. */
async function cmdBrowser(log) {
  const script = readAsset('browser-export.js');
  let copied = false;
  if (process.platform === 'darwin') {
    try {
      const r = spawnSync('pbcopy', { input: script });
      copied = r.status === 0;
    } catch {
      /* no pbcopy */
    }
  }
  log.info(`The browser route needs no token: the VK web page's own API client does the work.

1. In your browser, open https://vk.ru/im (or https://vk.com/im) and make sure you are logged in.
2. Open the developer console on that tab:
     Safari: first enable Safari > Settings > Advanced > "Show features for web developers",
             then Develop > Show JavaScript Console (Cmd+Option+C).
     Chrome: View > Developer > JavaScript Console (Cmd+Option+J).
3. Paste the script and press Enter.
     ${copied ? 'It is already on your clipboard, just press Cmd+V in the console.' : `Copy the whole file ${assetPath('browser-export.js')} and paste it.`}
   If the console refuses the paste, type "allow pasting" first (Chrome asks for this once).
4. Watch the [vk-archive] lines. It walks every conversation and saves files named
   vk-export-001.json, vk-export-002.json, ... into your Downloads folder. Allow multiple
   downloads if the browser asks. Keep the tab open until it says "All done".
5. Back here, run:
     node bin/vk-archive.js import ~/Downloads/vk-export-*.json
     node bin/vk-archive.js run --offline
   (or double-click "Import VK Export.command", which does both).
`);
  return 0;
}
