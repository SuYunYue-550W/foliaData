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
; 判断「是不是全新安装」**不能只看 $INSTDIR 的值**：electron-builder 在注册表
; 读不到 InstallLocation 时会退回系统默认路径（multiUser.nsh:47/90），而旧版
; 恰恰装在那个默认路径上 —— 于是 $INSTDIR 看起来像「全新安装」，被改到 D 盘，
; 覆盖安装就从「装在 C 盘」变成「卸 C 盘、装 D 盘」，旧目录里的进程也没被杀掉，
; 原故障原样复现。提交 649a56450 的说明写着「existing install keeps its own
; path」，实现与意图相反。
;
; 改成看**那个目录里是不是真的有 Folia.exe**：
;   · 目录里有 → 这位置已经装过 → 一个字都不动，覆盖安装继续用旧路径；
;   · 目录里没有 → 真是全新安装 → 才考虑 D 盘。
; 另外还看另一种安装模式的默认目录（per-user 与 per-machine 互查）：那一套装过
; 就不动，避免两套并存、卸载只清一套、用户启动到旧版本。
; 用户用 /D= 指定路径时 $INSTDIR 不等于任何默认值，天然不受影响。
;
; customInit 只在 .onInit 里跑，不碰进程 —— 用户点「取消」不会误杀正在播放的 Folia。
; ─────────────────────────────────────────────────────────────────────────────
!macro customInit
  ; 先认「当前 $INSTDIR 命中哪个默认位置」。
  StrCpy $1 "$LOCALAPPDATA\Programs\${APP_FILENAME}"
  StrCmp $INSTDIR $1 folia_default_per_user
  StrCpy $1 "$PROGRAMFILES\${APP_FILENAME}"
  StrCmp $INSTDIR $1 folia_default_per_machine
  StrCpy $1 "$PROGRAMFILES64\${APP_FILENAME}"
  StrCmp $INSTDIR $1 folia_default_per_machine
  ; 不是默认位置 → 已有自定义安装（或用户 /D= 指定）→ 不动。
  Goto folia_init_done

  ; ---- $INSTDIR 是 per-user 默认位置 ----
  folia_default_per_user:
  ; 这个位置自己装过吗？
  IfFileExists "$INSTDIR\Folia.exe" 0 folia_per_user_other_mode
  Goto folia_init_done

  folia_per_user_other_mode:
  ; per-machine 那套装过吗？装过就别再往 D 盘写一份。
  IfFileExists "$PROGRAMFILES\${APP_FILENAME}\Folia.exe" 0 folia_per_user_other_mode64
  DetailPrint "An existing all-users installation was found; keeping this install path."
  Goto folia_init_done
  folia_per_user_other_mode64:
  IfFileExists "$PROGRAMFILES64\${APP_FILENAME}\Folia.exe" 0 folia_use_dDrive
  DetailPrint "An existing all-users installation was found; keeping this install path."
  Goto folia_init_done

  ; ---- $INSTDIR 是 per-machine 默认位置 ----
  folia_default_per_machine:
  IfFileExists "$INSTDIR\Folia.exe" 0 folia_per_machine_other_mode
  Goto folia_init_done

  folia_per_machine_other_mode:
  ; per-user 那套装过吗？
  IfFileExists "$LOCALAPPDATA\Programs\${APP_FILENAME}\Folia.exe" 0 folia_use_dDrive
  DetailPrint "An existing per-user installation was found; keeping this install path."
  Goto folia_init_done

  ; ---- 真是全新安装 → D 盘 ----
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
  ;
  ; 杀 + 轮询都在这一个脚本里做完：NSIS 侧每轮再起一次 powershell.exe，光进程启动
  ; 就要几百毫秒，12 轮下来凭空多出好几秒，还多一批残留的 powershell 进程。
  ;
  ; 只杀「可执行文件在 $INSTDIR 下」且**文件名在已知名单里**的进程：
  ;   - 按名单圈定，不按映像名全局 taskkill —— 后者会误杀用户自己的同名程序；
  ;   - 排除自己（$PID）与父进程（NSIS 本体）—— 用户把 setup.exe 放在安装目录里
  ;     再运行时，不排除父进程就会把安装器自己杀掉，安装中断且无从察觉。
  ; 路径用命令行参数传，不写进脚本里：
  ; 脚本文件保持纯 ASCII，避免「NSIS 按 ANSI 写、PowerShell 按 ANSI 读」这条链路上
  ; 出现任何编码不一致 —— 用户把装到含中文的目录时，写进脚本的路径会经过两次转码。
  ; 作为参数传则是 PowerShell 直接拿 Unicode，绕开整条链路。
  FileOpen $1 "$TEMP\folia-kill-old.ps1" w
  FileWrite $1 "$$dir = if ($$args.Count -ge 1) { $$args[0] } else { '' }$\r$\n"
  FileWrite $1 "$$names = @('Folia','FoliaAppleMusicCompanion','ffmpeg','elevate')$\r$\n"
  FileWrite $1 "$$self = $$PID$\r$\n"
  FileWrite $1 "$$parent = (Get-CimInstance Win32_Process -Filter $\"ProcessId=$$self$\" -ErrorAction SilentlyContinue).ParentProcessId$\r$\n"
  FileWrite $1 "$$mine = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$dir + '\', [System.StringComparison]::OrdinalIgnoreCase) -and ($$names -contains [System.IO.Path]::GetFileNameWithoutExtension($$_.ExecutablePath)) -and $$_.ProcessId -ne $$self -and $$_.ProcessId -ne $$parent })$\r$\n"
  FileWrite $1 "$$mine | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }$\r$\n"
  FileWrite $1 "$$deadline = (Get-Date).AddSeconds(8)$\r$\n"
  FileWrite $1 "$$left = @()$\r$\n"
  FileWrite $1 "do {$$left = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$dir + '\', [System.StringComparison]::OrdinalIgnoreCase) -and ($$names -contains [System.IO.Path]::GetFileNameWithoutExtension($$_.ExecutablePath)) }); if ($$left.Count -eq 0) { break }; Start-Sleep -Milliseconds 300 } while ((Get-Date) -lt $$deadline)$\r$\n"
  FileWrite $1 "exit $$left.Count$\r$\n"
  FileClose $1
  ; ExecToStack：先 push stdout、后 push 退出码。实测（makensis 3.0.4.1 探针）：
  ;   `cmd /c exit 3` → Pop $0 = 3、Pop $1 = 空
  ;   `powershell -Command "exit @(…).Count"` → Pop $0 = 进程数、Pop $1 = 空
  ; 所以 $0 是本脚本退出时剩余的进程数，$1 是 stdout。
  nsExec::ExecToStack `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$TEMP\folia-kill-old.ps1" "$INSTDIR"`
  Pop $0
  Pop $1
  Delete "$TEMP\folia-kill-old.ps1"
  ; $0 仍是 0 就说明都退出了；不为 0 说明有顽固进程残留 —— 那正是旧卸载器
  ; atomicRMDir 失败的原因，放它过去必然重现 uninstallFailed: 2。
  StrCmp $0 0 folia_wait_done
  DetailPrint "Some Folia processes are still running; the old uninstaller may fail."
  Sleep 300
  folia_wait_done:
!macroend

!macro customCheckAppRunning
  !insertmacro foliaKillRunningProcesses
!macroend
