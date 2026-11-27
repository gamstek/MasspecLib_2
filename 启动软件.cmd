@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请先阅读 README.md 第 1 步，安装 Node.js 24.x x64。
  echo 官方下载地址：https://nodejs.org/zh-cn/download
  pause
  exit /b 1
)
node.exe scripts\novice-start.cjs
if errorlevel 1 (
  echo.
  echo 请根据上面的提示处理，再重新双击启动。详情请看 README.md。
  pause
  exit /b 1
)
endlocal
