@echo off
setlocal EnableExtensions
REM Pure ASCII on purpose: cmd.exe reads .bat in the system ANSI codepage (GBK here),
REM so non-ASCII literals become garbage commands. Chinese paths are resolved at
REM runtime via %~dp0 + wildcard, never written literally.
REM Starts the Vite dev server so you can check the redesigned Bilibili home tab.

set "BASE=%~dp0"
set "SRCDIR="
for /d %%D in ("%BASE%Folia*") do if exist "%%~fD\package.json" set "SRCDIR=%%~fD"
if not defined SRCDIR (
    echo ERROR: cannot locate the Folia source directory under %BASE%
    pause
    exit /b 1
)

REM Double-clicking a .bat does not inherit node/npm from an interactive shell.
set "PATH=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6;C:/Program Files\nodejs;%PATH%"
where npm >nul 2>nul
if errorlevel 1 (
    echo ERROR: npm not found in PATH
    pause
    exit /b 1
)

cd /d "%SRCDIR%"
echo ============================================
echo  Folia dev server - home tab visual check
echo ============================================
echo.
echo  Once it says "Local: http://localhost:5173/", open that address.
echo  Keep this window open. Press Ctrl+C to stop.
echo.
echo  Source: %SRCDIR%
echo.
set "BROWSER=none"
call npm run dev
pause
