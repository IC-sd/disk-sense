@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js/npm，请先安装 Node.js 并重新打开终端。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 正在安装项目依赖...
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败。
    pause
    exit /b 1
  )
)

echo 正在启动 Disk Sense 桌面热开发...
echo 修改 Vue、CSS 后，当前 Electron 窗口会自动更新。
echo 关闭此窗口会停止热开发服务。
call npm run dev:desktop
pause
