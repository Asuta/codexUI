@echo off
setlocal

cd /d "%~dp0"

where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm was not found. Please install pnpm first:
  echo npm install -g pnpm
  pause
  exit /b 1
)

echo Starting CodexUI...
echo.
echo Local URL will usually be:
echo   http://localhost:5174/
echo.
echo If 5174 is busy, Vite will print the actual URL below.
echo Keep this window open while using CodexUI.
echo.

pnpm run dev -- --host 0.0.0.0 --port 5174 --open

echo.
echo CodexUI has stopped.
pause
