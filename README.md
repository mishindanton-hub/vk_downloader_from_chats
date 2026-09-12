# VK Archive (vk-chat-archiver)

Offload **every** conversation from your VK (vk.com / vk.ru) account to disk: the full message
history plus all photos, videos, voice messages, documents, stickers and other attachments.
The result is a self-contained folder you can open in a browser years from now, with no VK
account needed.

- Zero dependencies, only Node.js 18+.
- Goes through every chat one by one until it runs out (private chats, group chats,
  community chats, archived chats).
- Resumable: stop it any time with Ctrl+C and re-run to continue; nothing is downloaded twice.
- Polite: stays under VK's rate limit and retries transient errors automatically.
- Output per chat: `messages.json` (raw API data), `messages.html` (browsable, works offline),
  `messages.txt` (plain text), and `media/` with the original files.

## Why the API and not a Chrome extension?

A browser extension that scrolls through vk.com and scrapes the DOM is tempting because you
are already logged in, but it is the worse tool for this job:

- the web UI lazy-loads a few dozen messages at a time and virtualises the list, so the
  extension has to fight scrolling, timing and memory for chats with tens of thousands of messages;
- the DOM only shows resized thumbnails; the full-size photo, the video file and the voice
  message need extra requests anyway;
- VK changes its markup regularly, and every change breaks a scraper;
- a crash halfway means starting over.

The VK API gives you the same data as clean JSON with stable pagination, direct links to
full-size files, and a well-defined rate limit. The only hard part is getting a token that is
allowed to read messages, and that is a one-time, two-minute step described below.

## Beginner guide (no programming needed)

The whole thing is one launcher. It works without a VK API token: your browser reads
the chats through your normal login, and the launcher downloads all the files.

1. **Install Node.js.** Open https://nodejs.org, download the "LTS" installer, run it.
   That is the only thing to install.
2. **Get this folder.** On the GitHub page click the green **Code** button, then
   **Download ZIP**, and unpack it (double-click on macOS).
3. **Double-click the launcher.** `VK Archive.command` on macOS, `VK Archive.bat` on
   Windows. A terminal window opens and guides you.
   - macOS blocks it the first time because it is not signed by Apple. On macOS 15 and
     newer the dialog says *"Apple could not verify ... is free of malware"*: click
     **Done**, open **System Settings → Privacy & Security**, scroll to the **Security**
     section, click **Open Anyway** next to the message about the blocked file, confirm
     with your password, and double-click the file again. On older macOS, right-click
     the file, choose **Open**, then **Open** again.
4. **Choose where to save.** The window asks for a folder. Press Enter for the default
   (`VK Archive` in your home folder) or drag any folder from Finder into the window and
   press Enter. The choice is remembered for next time and asked again on every run, so it
   is easy to change.
5. **Let the browser read the chats.** A tab with https://vk.ru/im opens; log in if
   needed. Open the JavaScript console on that tab (Chrome: Cmd+Option+J, Windows:
   Ctrl+Shift+J; Safari: enable **Settings → Advanced → Show features for web developers**
   once, then Cmd+Option+C). The export script is already on your clipboard: click into
   the console, paste, press Enter. If Chrome says "allow pasting", type `allow pasting`,
   press Enter, then paste again. Leave the tab open: it walks every chat, prints
   `[vk-archive]` progress lines, and saves `vk-export-001.json`, `vk-export-002.json`, ...
   into your Downloads folder (allow multiple downloads if asked).
6. **Wait.** The launcher window notices each file as it lands, and once the last one is in
   it downloads every photo, video, voice message and document into your folder and builds
   the pages. This can take hours for a big account. You can close the window at any time
   and double-click the launcher again later: it continues where it stopped and never
   downloads the same file twice.
7. **Look at the result.** It opens `index.html` in your archive folder when done. Every
   chat is there with messages, photos, voice messages and videos, all working offline.
   Copy the folder anywhere; it does not depend on VK or on this tool.

Running the launcher again later offers two choices: continue the existing archive
(download anything still missing, rebuild the pages), or export from the browser again to
pick up new messages.

### If something goes wrong

- **The console prints an error instead of `[vk-archive]` lines.** Make sure you are on
  the messenger page (`/im`) of vk.ru or vk.com and logged in, then paste again.
- **The browser tab was closed halfway.** Open `browser-export.js`, set `startFrom:` at
  the top to the number the console printed, and paste it again; the launcher picks up
  the new files.
- **Nothing appears in Downloads.** Check the browser's download location; you can point
  the launcher elsewhere with `--downloads /path` (see Terminal use below).
- **Advanced: token route.** The older way, an API token through the OAuth login of an
  official VK app, is still in the tool (`auth`, `whoami`, `diagnose`, `run`), but VK now
  often refuses such tokens with "Flood control". It is documented further down.

## Quick start (Terminal)

```bash
git clone <this repo> && cd vk_downloader_from_chats
node bin/vk-archive.js auth      # one-time: get a token (see below)
node bin/vk-archive.js whoami    # check the token works
node bin/vk-archive.js chats     # list what will be archived
node bin/vk-archive.js run       # archive everything into ./vk-archive
```

Token-free (what the launchers do):

```bash
node bin/vk-archive.js easy                    # guided: browser export -> import -> media
node bin/vk-archive.js easy --out ~/Desktop/VK --downloads ~/Downloads
# or the pieces by hand:
node bin/vk-archive.js browser                 # steps + script on the clipboard
node bin/vk-archive.js import ~/Downloads/vk-export-*.json
node bin/vk-archive.js run --offline
```

Optionally `npm link` to get a global `vk-archive` command.

## Getting a token (`vk-archive auth`)

VK does not grant the `messages` permission to ordinary third-party apps, so all VK export
tools log in through the OAuth implicit flow using the app id of an official client.
The default is Kate Mobile, which has worked reliably for years. You never type your
password anywhere except vk.com itself.

1. Run `node bin/vk-archive.js auth`. It prints a `https://oauth.vk.com/authorize?...` URL.
2. Open the URL in a browser where you are logged in to vk.com and confirm access.
3. The browser lands on a blank page whose address looks like
   `https://oauth.vk.com/blank.html#access_token=...&expires_in=0&user_id=...`.
   Copy the whole address and paste it into the terminal.
4. The token is saved to `~/.vk-archiver.json` (mode 600). You can also pass `--token`
   or set `VK_TOKEN` instead of saving it.

If Kate Mobile is refused, try `--app android`, `--app iphone`, `--app vkadmin` or any
`--app-id N`. If VK answers with a "validation required" page, complete it in the browser
and run `auth` again. Two-factor authentication works normally because the login happens
on vk.com.

### "[9] Flood control" or "[5] User authorization failed" right after logging in

VK answers this way when it dislikes the token itself, not the network. Run

```bash
node bin/vk-archive.js diagnose
```

It tries one `users.get` call per combination of host (`api.vk.ru` / `api.vk.com`),
API version and user agent, with no retries, and prints the flags that work
(for example `run --domain vk.ru --api-version 5.199 --no-user-agent`).
If every line says "Flood control": make sure no other Terminal window is still running
the tool, wait 15-30 minutes, and try again. If it still persists, get a token from
another official app (`auth --app android`, `--app iphone`, `--app vkme`, `--app vkadmin`),
or skip tokens altogether with the launcher / `easy` command described at the top.

The token can read everything in your account, so treat it like a password.
Revoke it afterwards at vk.com -> Settings -> Security -> Application access
(or just change your password).

## Running the archive

```bash
node bin/vk-archive.js run [options]

  --out DIR              output directory (default ./vk-archive)
  --domain vk.com|vk.ru  VK host to use (default vk.com, automatic fallback to the other)
  --peer ID[,ID...]      only these peers (user id, -group id, or 2000000000+chat id)
  --text-only            fetch history only, no media
  --no-video --no-photos --no-docs --no-voice --no-stickers --no-music
  --skip-groups          skip community conversations (newsletters, bots)
  --max-video-quality N  highest mp4 height to download (default 2160, e.g. 720)
  --concurrency N        parallel downloads (default 4)
  --retry-failed         retry media that previously failed with 403/404
  -v                     verbose logging
```

Suggested first pass on a big account:

```bash
node bin/vk-archive.js run --text-only          # all text first, fast (3 API calls/second, 200 messages each)
node bin/vk-archive.js run --no-video           # then photos, voice, docs, stickers
node bin/vk-archive.js run --max-video-quality 720   # then videos
```

Each run only adds what is missing: chats whose history is already complete are skipped,
and media that is already on disk is not downloaded again. To re-fetch one chat from
scratch (for example because new messages arrived), delete its `state.json` and
`messages.jsonl` and run again.

`node bin/vk-archive.js render` rebuilds the HTML/JSON/TXT from data already on disk
without any network access (useful after editing the templates).

`node bin/vk-archive.js import FILE...` loads `vk-export-*.json` files produced by
`browser-export.js` (the launcher flow) into the same layout, and `run --offline` then does the
media stage without a single API call. The two routes can be mixed: an imported chat is
simply a chat whose history is already complete.

## What you get

```
vk-archive/
  index.html                 list of all chats with counts and links
  conversations.json         raw conversation list
  names.json                 every user/community seen, with names
  me.json, summary.json
  user_12345_Ivan Petrov/
    messages.html            the chat, readable offline (light/dark)
    messages.json            {peer, participants, media index, messages[]} oldest first
    messages.txt             plain text transcript
    messages.jsonl           raw API messages as fetched, one per line (source of truth)
    media-index.json         what was downloaded where, and what failed and why
    state.json               progress bookkeeping
    videos-not-downloaded.txt  links to videos the API gives no file for (feed to yt-dlp)
    media/photos/photo12345_678.jpg
    media/videos/video12345_678_720p.mp4
    media/voice/am12345_678.mp3
    media/docs/doc12345_678_report.pdf
    media/stickers/, media/music/, media/other/
  chat_2000000123_Family/    group chats
  group_-9876_Some Public/   conversations with communities
```

Messages keep everything the API returns: forwarded messages (recursively), replies,
service actions (someone joined, chat renamed), edit times, geo, and all attachments.
Photos are downloaded at the largest available size. A photo forwarded ten times is stored once.

## Limitations and notes

- **Deleted conversations are gone.** The API only returns chats that still exist in your
  account. Chats you were kicked out of are listed but skipped (error 917).
- **Videos.** VK returns direct mp4 links for its own videos when the token comes from an
  official client (Kate Mobile does). Embedded YouTube/Rutube videos and HLS-only streams
  cannot be fetched directly; their links are written to `videos-not-downloaded.txt` and
  `yt-dlp -a videos-not-downloaded.txt` handles most of them.
- **Music.** Attached tracks are downloaded only when the API hands out a direct mp3 link;
  otherwise artist and title are recorded.
- **Expired attachments.** VK sometimes keeps a message but no longer serves its file
  (very old photos, files deleted by the sender). Those end up in `media-index.json` as
  `failed` with the HTTP status and are shown as "not downloaded" in the HTML.
- **Rate limits.** User tokens allow 3 requests per second. The tool stays just under it and
  backs off on "too many requests" and flood-control errors. A 100k-message account is
  roughly 500 history calls, i.e. a few minutes; media downloads dominate the total time.
- **Captcha.** If VK demands a captcha, the tool prints the image URL and waits for you to
  type the text.
- The official VK "Download your data" archive (Settings -> Privacy -> Request archive) is a
  decent second copy of the text but contains only links to media, not the files.

## Development

```bash
npm test     # runs the unit tests and an end-to-end run against a local fake VK API
```

`test/fake-vk.js` implements just enough of `messages.getConversations`,
`messages.getHistory`, `video.get`, `users.get`, `groups.getById` and a file host to exercise
pagination, retries, every attachment type, 404s, and resumability. Point the CLI at it with
`VK_API_BASE=http://127.0.0.1:PORT/method/ VK_TOKEN=test-token`.
