@echo off
title ARCHIVEX Office File Tracker
cd /d "%~dp0"

:check
netstat -ano | findstr /R ":3000 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [ARCHIVEX] Port 3000 is already in use - a server is probably running.
    echo [ARCHIVEX] Open http://localhost:3000 in your browser.
    echo [ARCHIVEX] Re-checking every 10 seconds in case it stops...
    timeout /t 10 >nul
    goto check
)

:start
echo [ARCHIVEX] Starting server...   http://localhost:3000
node server.js
echo.
echo [ARCHIVEX] Server stopped. Restarting automatically in 5 seconds...
timeout /t 5 >nul
goto start
