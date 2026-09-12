#!/bin/bash
# Double-click this file in Finder (macOS) to run the archiver.
# It opens a Terminal window, checks that Node.js is installed, logs you in
# once (asks you to paste the URL), and then archives everything into the
# "vk-archive" folder next to this file. Re-running continues where it stopped.

cd "$(dirname "$0")" || exit 1

pause() { echo; read -r -p "Press Enter to close this window..." _; }

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed."
  echo "1. Open https://nodejs.org and download the LTS installer for macOS."
  echo "2. Install it, then double-click this file again."
  pause
  exit 1
fi

MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$MAJOR" -lt 18 ]; then
  echo "Node.js $(node -v) is too old; version 18 or newer is required. Update at https://nodejs.org"
  pause
  exit 1
fi

CONFIG="${VK_ARCHIVE_CONFIG:-$HOME/.vk-archiver.json}"
if [ ! -f "$CONFIG" ]; then
  echo "First run: you need to log in once."
  node bin/vk-archive.js auth || { pause; exit 1; }
fi

echo
node bin/vk-archive.js whoami || {
  echo
  echo "The saved token does not work. Delete $CONFIG and run this again to log in afresh."
  pause
  exit 1
}

echo
echo "Archiving everything into: $(pwd)/vk-archive"
echo "You can close this window at any time and run it again later; it continues where it stopped."
echo
node bin/vk-archive.js run "$@"
STATUS=$?
echo
if [ $STATUS -eq 0 ]; then
  echo "Done. Open vk-archive/index.html in your browser to look at the result."
else
  echo "Stopped with an error (code $STATUS). Run this file again to continue."
fi
pause
