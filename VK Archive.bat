@echo off
rem VK Archive for Windows: starts the local service and opens the interface in your browser.
rem Uses the standalone "VK Archive.exe" when it is next to this file, otherwise Node.js with
rem the source. Anything that goes wrong is printed in this window instead of disappearing.
setlocal
cd /d "%~dp0"
set "LOG=%LOCALAPPDATA%\VK Archive.log"
if not exist "%LOCALAPPDATA%" set "LOG=%TEMP%\VK Archive.log"
echo [%date% %time%] launching from "%~dp0" >>"%LOG%"

if exist "VK Archive.exe" (
  rem Self-check first: if Windows blocks the program, this prints the reason
  rem instead of a window that opens and vanishes.
  "VK Archive.exe" --version >>"%LOG%" 2>&1
  if errorlevel 1 goto blocked
  echo Starting VK Archive... your browser will open in a moment.
  echo [%date% %time%] using bundled program >>"%LOG%"
  start "VK Archive" /min "VK Archive.exe" gui
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 goto nonode
if not exist "bin\vk-archive.js" goto nofiles
echo Starting VK Archive... your browser will open in a moment.
echo [%date% %time%] using node with the source >>"%LOG%"
start "VK Archive" /min node bin\vk-archive.js gui
exit /b 0

:blocked
echo.
echo   VK Archive could not start.
echo.
echo   Windows would not run "VK Archive.exe". This is Windows protecting you from a
echo   program it has not seen before - it is not a fault in the archive.
echo.
echo   Try this:
echo     1. Right-click "VK Archive.exe", choose Properties, tick "Unblock" at the
echo        bottom of the General tab, click OK, then run this file again.
echo     2. If a blue "Windows protected your PC" box appears, click "More info"
echo        and then "Run anyway".
echo     3. Or check that your antivirus has not quarantined the file.
echo.
echo   The details are in: "%LOG%"
echo   Your archive folder is untouched; nothing was lost.
echo.
pause
exit /b 1

:nonode
echo.
echo   VK Archive could not start.
echo.
echo   There is no "VK Archive.exe" next to this file and Node.js is not installed.
echo   Install the LTS version from nodejs.org (free, a couple of clicks), then run
echo   this file again - or download the ready-made package from the project's
echo   Releases page, which needs nothing installed.
echo.
echo [%date% %time%] FAILED: no exe and no node >>"%LOG%"
start "" https://nodejs.org
pause
exit /b 1

:nofiles
echo.
echo   VK Archive could not start.
echo.
echo   The program files are missing next to this file (bin\vk-archive.js).
echo   Unzip the whole download and keep "VK Archive.bat" next to the other files,
echo   then run it again.
echo.
echo [%date% %time%] FAILED: no bin\vk-archive.js >>"%LOG%"
pause
exit /b 1
