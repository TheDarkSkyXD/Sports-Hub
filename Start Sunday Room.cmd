@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Sunday Room needs its dependencies. Run npm install first.
  pause
  exit /b 1
)
start "Sunday Room" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0desktop\main.cjs"
