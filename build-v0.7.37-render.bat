@echo off
setlocal EnableExtensions
REM Pure ASCII on purpose: cmd.exe reads .bat in the system ANSI codepage (GBK here),
REM so any non-ASCII literal in this file becomes garbage commands. All Chinese
REM paths are resolved at runtime via %~dp0 + wildcard, never written literally.

set "BASE=%~dp0"
set "SRCDIR="
for /d %%D in ("%BASE%Folia*") do if exist "%%~fD\package.json" set "SRCDIR=%%~fD"
if not defined SRCDIR (
    echo ERROR: cannot locate the Folia source directory under %BASE%
    pause
    exit /b 1
)

set "NODE_OPTIONS="
set "UV_THREADPOOL_SIZE=1"
set "ELECTRON_RUN_AS_NODE="
set "CODEBUDDY_SAFE_DELETE_ENABLED="

cd /d "%SRCDIR%"

echo ===== [1/3] Electron render build =====
set "FOLIA_BUILD_TARGET=electron"
set "ELECTRON_DEV=false"
set "ELECTRON=true"
node node_modules\vite\bin\vite.js build
if errorlevel 1 goto fail_electron
if not exist dist\index.html goto fail_electron

echo ===== [2/3] Backup electron dist =====
if exist "%BASE%.workbuddy\dist_v0737_electron" rmdir /s /q "%BASE%.workbuddy\dist_v0737_electron"
move dist "%BASE%.workbuddy\dist_v0737_electron"

echo ===== [3/3] Capacitor render build =====
set "FOLIA_BUILD_TARGET=capacitor"
set "ELECTRON_DEV=false"
set "ELECTRON=false"
node node_modules\vite\bin\vite.js build
if errorlevel 1 goto fail_capacitor
if not exist dist\index.html goto fail_capacitor

echo ===== DONE: both render builds OK =====
echo Electron dist backup: .workbuddy\dist_v0737_electron
echo Capacitor dist: folia-source\dist
pause
exit /b 0

:fail_electron
echo ELECTRON_BUILD_FAILED
pause
exit /b 1

:fail_capacitor
echo CAPACITOR_BUILD_FAILED
pause
exit /b 1
