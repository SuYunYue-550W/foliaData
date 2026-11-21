@echo off
setlocal EnableExtensions
REM Pure ASCII: build ONLY the Capacitor/Android renderer into Folia source dist.
set "BASE=%~dp0"
set "SRCDIR="
for /d %%D in ("%BASE%Folia*") do if exist "%%~fD\package.json" set "SRCDIR=%%~fD"
if not defined SRCDIR (
    echo ERROR: source dir not found under %BASE%
    pause
    exit /b 1
)
cd /d "%SRCDIR%"
set "NODE_OPTIONS="
set "UV_THREADPOOL_SIZE=1"
set "ELECTRON_RUN_AS_NODE="
set "CODEBUDDY_SAFE_DELETE_ENABLED="
set "FOLIA_BUILD_TARGET=capacitor"
set "ELECTRON_DEV=false"
set "ELECTRON=false"
echo ===== Building Capacitor renderer =====
node node_modules\vite\bin\vite.js build
if errorlevel 1 goto fail
if not exist dist\index.html goto fail
echo ===== DONE: capacitor dist ready =====
pause
exit /b 0
:fail
echo CAPACITOR_BUILD_FAILED
pause
exit /b 1
