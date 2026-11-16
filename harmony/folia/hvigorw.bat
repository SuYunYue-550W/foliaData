@echo off
@REM HarmonyOS Hvigor 包装器（Windows）。
@REM 本仓库只带源码与配置；首次在 DevEco Studio 打开工程并 Sync 后，DevEco 会生成完整的
@REM hvigorw.bat / hvigorw / hvigor/hvigor-wrapper.js。若本文件是占位的 _real 转发版，
@REM 它会调用 hvigorw.real.cmd；否则回退到全局 hvigorw。
@REM 见 harmony/README.md 的「生成构建包装器」一节。
setlocal
set REAL="%~dp0hvigorw.real.cmd"
if exist %REAL% (
  call %REAL% %*
  exit /b %ERRORLEVEL%
)
where hvigorw >nul 2>nul
if %ERRORLEVEL% equ 0 (
  call hvigorw %*
  exit /b %ERRORLEVEL%
)
echo [FoliaHarmony] hvigorw wrapper not ready: open this project in DevEco Studio and run File ^> Sync and Refresh Project, then commit the generated hvigorw.bat. 1>&2
exit /b 1
