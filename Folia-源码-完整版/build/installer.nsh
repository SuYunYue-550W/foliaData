LangString foliaUserDataPrompt 1033 "Delete user data?"
LangString foliaUserDataPrompt 2052 "是否删除用户数据？"
LangString foliaUserDataPrompt 1057 "Hapus data pengguna?"

!macro customUnInstall
  ; Electron always uses per-user app data, so look under the current user's
  ; roaming profile even when the installation itself is per-machine.
  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}

  IfFileExists "$APPDATA\${APP_FILENAME}\*.*" 0 folia_skipUserDataPrompt

  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$(foliaUserDataPrompt)" /SD IDNO IDYES folia_deleteUserData
  Goto folia_skipUserDataPrompt

  folia_deleteUserData:
    RMDir /r "$APPDATA\${APP_FILENAME}"
    !ifdef APP_PRODUCT_FILENAME
      RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
    !endif
    !ifdef APP_PACKAGE_NAME
      RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    !endif

  folia_skipUserDataPrompt:
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
!macroend

; ─────────────────────────────────────────────────────────────────────────────
; 默认装到 D 盘（不放系统盘）
;
; electron-builder 在 initMultiUser 里已经按注册表/默认位置设好了 $INSTDIR，
; customInit 在它之后执行（见 installer.nsi 的 .onInit）。
;
; 只把「全新安装」的默认目录改到 D:\Folia：
;   · 已有旧安装（注册表有 InstallLocation，$INSTDIR 指向旧目录）→ 一个字都不动，
;     让覆盖安装继续用旧路径，避免「卸了 C 盘却装到 D 盘」把快捷方式/卸载器搞乱。
;   · 用户用 /D=路径 显式指定 → 也尊重，不覆盖。
;   · 只有 $INSTDIR 仍是系统默认位置时才换成 D:\Folia。
;
; customInit 只在 .onInit 里跑，不碰进程 —— 用户点「取消」不会误杀正在播放的 Folia。
; ─────────────────────────────────────────────────────────────────────────────
!macro customInit
  ; 注：不用 GetDParameter —— 它定义在 multiUser.nsh，晚于本文件被 include。
  ; 但 /D=path 设置的 $INSTDIR 不会等于下面任何默认值，自然不会触发 D 盘覆盖，
  ; 所以显式指定路径的用户不受影响。
  ;
  ; 判断是不是「系统默认位置」（还没装过）：
  ; per-user  默认 %LOCALAPPDATA%\Programs\Folia
  ; per-machine 默认 $PROGRAMFILES\Folia / $PROGRAMFILES64\Folia
  ; 命中其中任何一个都说明没有自定义安装记录，可以换成 D 盘。
  StrCpy $1 "$LOCALAPPDATA\Programs\${APP_FILENAME}"
  StrCmp $INSTDIR $1 folia_use_dDrive
  StrCpy $1 "$PROGRAMFILES\${APP_FILENAME}"
  StrCmp $INSTDIR $1 folia_use_dDrive
  StrCpy $1 "$PROGRAMFILES64\${APP_FILENAME}"
  StrCmp $INSTDIR $1 folia_use_dDrive
  Goto folia_init_done

  folia_use_dDrive:
    ; D 盘不存在时（比如没有 D 盘）保持默认，不让安装器直接失败。
    IfFileExists "D:\*.*" 0 folia_init_done
    StrCpy $INSTDIR "D:\${APP_FILENAME}"

  folia_init_done:
!macroend

; ─────────────────────────────────────────────────────────────────────────────
; 覆盖安装前结束旧版进程
;
; 症状：旧版进程占着安装目录里的 app.asar、*.dll，electron-builder 的
; CHECK_APP_RUNNING 弹「Folia 无法关闭」，uninstallOldVersion 随后返回非零，
; 弹「Failed to uninstall old application files…: 2」。
;
; 之前的实现只杀 ProcessName -eq 'Folia'、只等 400ms，把 electron-builder 自带的
; 轮询重试整个替换掉了。而安装目录里还有 FoliaAppleMusicCompanion.exe、ffmpeg.exe
; 这些 detached helper —— 进程名不等于 Folia，照样锁着 app.asar，覆盖安装就失败。
;
; 现在改成：按「可执行文件位于 $INSTDIR 下」杀**所有**相关进程，然后轮询校验
; 直到真的没有进程残留（最多约 6 秒），再交给卸载器。只挂在 customCheckAppRunning：
; 它在安装流程内执行，用户点「取消」时不会触发。
;
; 位置说明：本文件被 !include 在 Section / Function 之外，只能写编译期指令，
; 运行时代码必须包在宏里由官方钩子调用。
; ─────────────────────────────────────────────────────────────────────────────
!macro foliaKillRunningProcesses
  ; 生成临时脚本，避免 PowerShell 引号在 NSIS / cmd 多层转义中被吃掉。
  ; $$ 是 NSIS 的字面 $；$\r$\n 是换行。
  ; 按 ExecutablePath 前缀匹配 $INSTDIR，覆盖主程序 + 所有 helper。
  FileOpen $1 "$TEMP\folia-kill-old.ps1" w
  FileWrite $1 "$$procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$INSTDIR\', [System.StringComparison]::OrdinalIgnoreCase) }); $$procs | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }$\r$\n"
  FileClose $1
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$TEMP\folia-kill-old.ps1"`
  Pop $0
  Delete "$TEMP\folia-kill-old.ps1"

  ; 轮询校验：确认进程真的退出了再往下走。只 Sleep 400ms 对 184MB 的 app.asar 不够。
  StrCpy $2 0
  folia_wait_loop:
    nsExec::ExecToStack `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "exit @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$INSTDIR\', [System.StringComparison]::OrdinalIgnoreCase) }).Count"`
    Pop $0
    Pop $1
    StrCmp $0 0 folia_wait_done
    IntOp $2 $2 + 1
    IntCmp $2 12 folia_wait_done folia_wait_done folia_wait_more
    folia_wait_more:
      Sleep 500
      Goto folia_wait_loop
  folia_wait_done:
    Sleep 300
!macroend

!macro customCheckAppRunning
  !insertmacro foliaKillRunningProcesses
!macroend
