@echo off
rem Windows: double-click this file. It guides you through saving all your VK chats.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Open https://nodejs.org, install the LTS version, then run this again.
  start "" https://nodejs.org
  pause
  exit /b 1
)
node bin\vk-archive.js easy %*
if errorlevel 1 echo Stopped. Double-click this file again to continue where it stopped.
pause
