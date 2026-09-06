@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or later from https://nodejs.org
  pause
  exit /b 1
)
node local/server.mjs
pause
