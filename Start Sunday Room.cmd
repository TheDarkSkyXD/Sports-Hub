@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Sunday Room needs its dependencies. Run npm install first.
  pause
  exit /b 1
)
set "SUNDAY_ROOM_ROOT=%~dp0"
powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath node.exe -ArgumentList ([char]34 + (Join-Path $env:SUNDAY_ROOM_ROOT 'scripts\desktop.mjs') + [char]34) -WorkingDirectory $env:SUNDAY_ROOM_ROOT -WindowStyle Hidden"
