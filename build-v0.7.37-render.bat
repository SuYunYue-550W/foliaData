@echo off
chcp 65001 >nul
REM v0.7.37 渲染层构建（Agent 沙箱里 vite build 会卡在 rendering chunks，只能本机跑）
REM 双击运行，跑完把窗口最后几行截图发我。之后打包/上传由我接手。
cd /d "C:\Users\芒果游泳\Desktop\foliaData\Folia-源码-完整版"

set NODE_OPTIONS=
set UV_THREADPOOL_SIZE=1
set ELECTRON_RUN_AS_NODE=
set CODEBUDDY_SAFE_DELETE_ENABLED=

echo ===== [1/2] Electron 渲染层 =====
set FOLIA_BUILD_TARGET=electron
set ELECTRON_DEV=false
set ELECTRON=true
node node_modules\vite\bin\vite.js build
if errorlevel 1 (echo ELECTRON_BUILD_FAILED & pause & exit /b 1)
if not exist dist\index.html (echo ELECTRON_BUILD_NO_INDEX & pause & exit /b 1)

echo ===== [1/2] 备份 Electron dist =====
if exist "..\.workbuddy\dist_v0737_electron" rmdir /s /q "..\.workbuddy\dist_v0737_electron"
move dist "..\.workbuddy\dist_v0737_electron"

echo ===== [2/2] Capacitor(Android) 渲染层 =====
set FOLIA_BUILD_TARGET=capacitor
set ELECTRON_DEV=false
set ELECTRON=false
node node_modules\vite\bin\vite.js build
if errorlevel 1 (echo CAPACITOR_BUILD_FAILED & pause & exit /b 1)
if not exist dist\index.html (echo CAPACITOR_BUILD_NO_INDEX & pause & exit /b 1)

echo ===== DONE: both render builds OK =====
echo Electron dist: .workbuddy\dist_v0737_electron
echo Capacitor dist: Folia-源码-完整版\dist
pause
