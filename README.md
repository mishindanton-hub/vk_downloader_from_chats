# vk-chat-archiver

Offload **every** conversation from your VK (vk.com) account to disk: the full message
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

## Beginner guide (macOS, no programming needed)

1. **Install Node.js.** Open https://nodejs.org, download the "LTS" installer for macOS,
   open the downloaded `.pkg` and click through it. That is the only thing to install.
2. **Get this folder onto your Mac.** On the GitHub page click the green **Code** button,
   then **Download ZIP**. Double-click the ZIP in Downloads to unpack it. You get a folder
   named `vk_downloader_from_chats-...`. Move it somewhere with plenty of free space
   (the archive is saved inside it and photos and videos add up).
3. **Start it.** Inside the folder, double-click `Start VK Archive.command`.
   The first time macOS blocks it, because the file was downloaded from the internet
   and is not signed by Apple. Which dialog you get depends on your macOS version:
   - *"Apple could not verify ... is free of malware"* with **Done** / **Move to Bin**
     (macOS 15 Sequoia and newer): click **Done**. Open **System Settings**, go to
     **Privacy & Security**, scroll down to the **Security** section. It says
     `"Start VK Archive.command" was blocked to protect your Mac`; click
     **Open Anyway** next to it, enter your Mac password, and click **Open Anyway**
     again in the confirmation. Now double-click the file again. This is needed once.
   - *"cannot be opened because it is from an unidentified developer"* (older macOS):
     right-click (or Control-click) the file, choose **Open**, then **Open** again.

   A Terminal window appears. If none of that works, you can skip the launcher
   entirely: open **Terminal** (Spotlight: press Cmd+Space, type `Terminal`), type
   `cd ` (with a space), drag the unpacked folder from Finder into the Terminal
   window, press Enter, and then run the three commands from the Quick start section
   below (`auth`, `whoami`, `run`).
4. **Log in once.** The window prints a long `https://oauth.vk.com/authorize?...` link.
   Copy it into your browser (where you are already logged in to VK) and press
   **Allow**. You land on a blank page. Copy the whole address from the browser's
   address bar (it starts with `https://oauth.vk.com/blank.html#access_token=`) and
   paste it back into the Terminal window, then press Enter. The token is saved, so
   you never do this again.
5. **Wait.** The window shows progress chat by chat. You can close it whenever you like
   and double-click the file again later; it continues where it stopped and never
   downloads the same file twice.
6. **Look at the result.** When it says "Done", open `vk-archive/index.html` inside the
   folder in any browser. Every chat is listed with its messages, photos, voice
   messages and videos, all working offline.

If the login link does not open (VK has been moving from `vk.com` to `vk.ru`), run the
tool once from Terminal with the other domain and then use the launcher as usual:

```bash
cd ~/Downloads/vk_downloader_from_chats-*    # wherever you put the folder
node bin/vk-archive.js auth --domain vk.ru
```

The API calls themselves switch between `api.vk.com` and `api.vk.ru` automatically if
one of them is unreachable.

## Quick start (Terminal)

```bash
git clone <this repo> && cd vk_downloader_from_chats
node bin/vk-archive.js auth      # one-time: get a token (see below)
node bin/vk-archive.js whoami    # check the token works
node bin/vk-archive.js chats     # list what will be archived
node bin/vk-archive.js run       # archive everything into ./vk-archive
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
