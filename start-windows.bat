@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.5 or newer is required. Install Node.js, then run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing required packages...
  call npm install
  if errorlevel 1 (
    echo Package installation failed.
    pause
    exit /b 1
  )
)
if not exist .env copy .env.example .env >nul
echo Starting Data Science Portal...
call npm start
pause
