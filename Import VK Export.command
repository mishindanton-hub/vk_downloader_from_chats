#!/bin/bash
# Double-click this file (macOS) AFTER running browser-export.js in the VK web page's
# console. It imports the vk-export-*.json files from your Downloads folder and then
# downloads all media and builds the HTML archive, without needing any token.
# Re-running continues where it stopped.

cd "$(dirname "$0")" || exit 1
pause() { echo; read -r -p "Press Enter to close this window..." _; }

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Open https://nodejs.org, install the LTS version, then run this again."
  pause; exit 1
fi

shopt -s nullglob
FILES=("$HOME/Downloads"/vk-export-*.json)
if [ ${#FILES[@]} -eq 0 ]; then
  echo "No vk-export-*.json files found in $HOME/Downloads."
  echo
  echo "First export the chats from the VK web page:"
  node bin/vk-archive.js browser
  pause; exit 1
fi

echo "Found ${#FILES[@]} export file(s) in Downloads. Importing..."
node bin/vk-archive.js import "${FILES[@]}" || { pause; exit 1; }

echo
echo "Downloading media and building the archive in: $(pwd)/vk-archive"
echo "You can close this window at any time and run it again later; it continues where it stopped."
echo
node bin/vk-archive.js run --offline "$@"
STATUS=$?
echo
if [ $STATUS -eq 0 ]; then
  echo "Done. Open vk-archive/index.html in your browser to look at the result."
else
  echo "Stopped with an error (code $STATUS). Run this file again to continue."
fi
pause
