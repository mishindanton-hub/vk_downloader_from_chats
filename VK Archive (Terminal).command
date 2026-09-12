#!/bin/bash
# macOS: double-click this file. It opens a Terminal window that guides you through
# saving all your VK chats (text, photos, videos, voice messages, documents).
# First time only: macOS may block it ("Apple could not verify ..."). Click Done, then
# System Settings > Privacy & Security > "Open Anyway", and double-click again.
cd "$(dirname "$0")" || exit 1
pause() { echo; read -r -p "Press Enter to close this window..." _; }

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed (it is the only thing this tool needs)."
  echo "1. Open https://nodejs.org and download the LTS installer for macOS."
  echo "2. Install it, then double-click this file again."
  open "https://nodejs.org" 2>/dev/null
  pause; exit 1
fi
MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$MAJOR" -lt 18 ]; then
  echo "Node.js $(node -v) is too old; 18 or newer is required. Update at https://nodejs.org"
  pause; exit 1
fi

node bin/vk-archive.js easy "$@"
STATUS=$?
if [ $STATUS -ne 0 ]; then
  echo
  echo "Stopped (code $STATUS). You can double-click this file again; it continues where it stopped."
fi
pause
