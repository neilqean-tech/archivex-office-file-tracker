@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = Get-Date -Format 'yyyyMMdd_HHmmss'; New-Item -ItemType Directory -Force -Path '_snapshots' | Out-Null; Copy-Item 'server.js' ('_snapshots\server_' + $s + '.bak') -Force; Copy-Item 'public\index.html' ('_snapshots\index_' + $s + '.bak') -Force; Copy-Item 'package.json' ('_snapshots\package_' + $s + '.bak') -Force; Write-Host ('Code snapshot saved to _snapshots  (' + $s + ')')"
pause
