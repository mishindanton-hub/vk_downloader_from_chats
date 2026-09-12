@echo off
rem VK Archive for Windows: starts the local service (minimized window) and opens the interface in your browser.
rem Uses the standalone "VK Archive.exe" when it is next to this file, otherwise Node.js with the source.
cd /d "%~dp0"
if exist "VK Archive.exe" (
  start "VK Archive" /min "VK Archive.exe" gui
  exit /b 0
)
where node >nul 2>nul
if errorlevel 1 (
  echo VK Archive needs Node.js (free). Opening nodejs.org - install the LTS version, then run this file again.
  start "" https://nodejs.org
  pause
  exit /b 1
)
start "VK Archive" /min node bin\vk-archive.js gui
