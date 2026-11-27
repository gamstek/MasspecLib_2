@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先按 README.md 安装 Node.js 24.x x64。
  pause
  exit /b 1
)
node.exe scripts\novice-start.cjs --check
set "CHECK_RESULT=%ERRORLEVEL%"
pause
exit /b %CHECK_RESULT%
