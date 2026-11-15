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
; 覆盖安装前结束旧版 Folia 进程
;
; 症状：旧版 Folia.exe（含 GPU / 渲染子进程）占着安装目录里的 app.asar、*.dll，
; electron-builder 的 CHECK_APP_RUNNING 弹「Folia 无法关闭。请手动关闭它…」，
; uninstallOldVersion 随后返回非零，弹「Failed to uninstall old application files…: 2」。
;
; 只挂在 customCheckAppRunning：它在安装器已进入安装流程、CHECK_APP_RUNNING 展开时执行。
; 绝不挂 customInit（.onInit）—— 那是安装器最早执行的用户代码，项目 oneClick:false，
; 挂上去会导致用户双击安装器后哪怕点「取消」，正在放音乐的 Folia 已被无预警强杀。
;
; 只结束「可执行文件位于 $INSTDIR 内」的同名进程。按映像名全局 taskkill 会误杀
; 另一份安装或用户自己的同名程序；这里用 PowerShell 按 Process.Path 过滤。
;
; 位置说明：本文件在生成脚本较靠前的位置被 !include，不在 Section / Function 内，
; 因此这里只能写编译期指令（宏定义 / !define），运行时指令必须包在宏里由官方钩子调用，
; 否则 makensis 会报 "Can't add entry, no section or function is open!"。
; ─────────────────────────────────────────────────────────────────────────────
!ifndef FOLIA_PROC_NAME
  !ifdef APP_FILENAME
    !define FOLIA_PROC_NAME "${APP_FILENAME}"
  !else
    !define FOLIA_PROC_NAME "Folia"
  !endif
!endif

!macro foliaForceKillOldProcess
  ; 生成临时脚本，避免 PowerShell 引号在 NSIS / cmd 多层转义中被吃掉。
  ; $$ 是 NSIS 的字面 $；$\r$\n 是换行。
  FileOpen $1 "$TEMP\folia-kill-old.ps1" w
  FileWrite $1 "Get-Process -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '$INSTDIR\*' -and $$_.ProcessName -eq '${FOLIA_PROC_NAME}' } | Stop-Process -Force$\r$\n"
  FileClose $1
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$TEMP\folia-kill-old.ps1"`
  Pop $0
  Delete "$TEMP\folia-kill-old.ps1"
  Sleep 400
!macroend

; electron-builder 用它替换默认的「检测运行中应用」逻辑：不再弹窗询问，直接结束
; 安装目录内的旧进程，避免「Folia 无法关闭」与 uninstallFailed: 2。
!macro customCheckAppRunning
  !insertmacro foliaForceKillOldProcess
!macroend
