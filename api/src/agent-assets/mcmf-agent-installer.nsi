; MCMF Endpoint Agent — Windows installer (built with NSIS / makensis on the MCMF server).
; Produces MCMF-Agent-Setup.exe: installs the agent, registers it to auto-start at logon
; (hidden, highest privileges), adds a Start-Menu entry + uninstaller, and launches it.
; Works on Windows 10 / 11 and Server 2016+ (PowerShell 5.1 + .NET WinForms, both in-box).

!define APPNAME "MCMF Endpoint Agent"
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\MCMFEndpointAgent"

Name "${APPNAME}"
OutFile "MCMF-Agent-Setup.exe"
Unicode True
InstallDir "$PROGRAMFILES\MCMF"
RequestExecutionLevel admin
ShowInstDetails show
ShowUninstDetails show
BrandingText "MCMF Endpoint Agent"

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

!define SVCTASK "MCMF Endpoint Agent (Service)"

Section "Install"
  SetShellVarContext all          ; $APPDATA -> C:\ProgramData, $SMPROGRAMS -> All Users
  SetOutPath "$INSTDIR"
  File "mcmf-tray-agent.ps1"

  ; Clean upgrade — stop + remove any prior/legacy MCMF agent so only the outbound agent runs.
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ScheduledTask -TaskName ''MCMF*'' -EA SilentlyContinue | Stop-ScheduledTask -EA SilentlyContinue; Get-CimInstance Win32_Process -EA SilentlyContinue | Where-Object { $_.CommandLine -like ''*mcmf-tray-agent*'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }; Unregister-ScheduledTask -TaskName ''MCMF Guest Agent'' -Confirm:$false -EA SilentlyContinue; Unregister-ScheduledTask -TaskName ''MCMF Agent'' -Confirm:$false -EA SilentlyContinue"'

  ; Shared config dir, writable by both the SYSTEM service and the logged-in tray user.
  CreateDirectory "$APPDATA\MCMF"
  nsExec::ExecToLog 'icacls "$APPDATA\MCMF" /grant *S-1-5-32-545:(OI)(CI)M /T'

  ; Pure outbound — the agent dials home over HTTPS and needs NO inbound port. Remove any legacy
  ; inbound rule a previous build may have added.
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="MCMF Agent 9182"'

  ; ---- ALWAYS-ON TELEMETRY: headless engine as a SYSTEM task, at boot, restart-on-failure ----
  ; Survives logoff / reboot / crash — this is what keeps the host "online" in MCMF.
  FileOpen $1 "$INSTDIR\install-service-task.ps1" w
  FileWrite $1 "$$ErrorActionPreference='SilentlyContinue'$\r$\n"
  FileWrite $1 "$$agent = $\"$INSTDIR\mcmf-tray-agent.ps1$\"$\r$\n"
  FileWrite $1 "$$act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $\"' + $$agent + '$\" -Service')$\r$\n"
  FileWrite $1 "$$trg = New-ScheduledTaskTrigger -AtStartup$\r$\n"
  FileWrite $1 "$$prn = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -RunLevel Highest$\r$\n"
  FileWrite $1 "$$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 -ExecutionTimeLimit ([TimeSpan]::Zero)$\r$\n"
  FileWrite $1 "Register-ScheduledTask -TaskName '${SVCTASK}' -Action $$act -Trigger $$trg -Principal $$prn -Settings $$set -Force | Out-Null$\r$\n"
  FileWrite $1 "Start-ScheduledTask -TaskName '${SVCTASK}'$\r$\n"
  FileClose $1
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\install-service-task.ps1"'

  ; ---- TRAY UI: hidden, console-less launcher (wscript runs the VBS with no window) ----
  FileOpen $0 "$INSTDIR\launch.vbs" w
  FileWrite $0 'Set sh = CreateObject("WScript.Shell")$\r$\n'
  FileWrite $0 'base = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))$\r$\n'
  FileWrite $0 'sh.Run "powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & base & "mcmf-tray-agent.ps1""", 0, False$\r$\n'
  FileClose $0

  ; Tray UI auto-starts at logon (highest privileges, so the admin/UAC gate works). Registered via
  ; PowerShell Register-ScheduledTask written to a file — schtasks /tr with a quoted path under
  ; "C:\Program Files (x86)\..." breaks its own quoting and errors with "Invalid argument 'Files'".
  FileOpen $2 "$INSTDIR\install-logon-task.ps1" w
  FileWrite $2 "$$lvbs = $\"$INSTDIR\launch.vbs$\"$\r$\n"
  FileWrite $2 "$$tact = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('$\"' + $$lvbs + '$\"')$\r$\n"
  FileWrite $2 "$$tprn = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Highest$\r$\n"
  FileWrite $2 "Register-ScheduledTask -TaskName '${APPNAME}' -Action $$tact -Trigger (New-ScheduledTaskTrigger -AtLogon) -Principal $$tprn -Force | Out-Null$\r$\n"
  FileClose $2
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\install-logon-task.ps1"'

  ; Start-Menu + Desktop shortcuts so the agent has an app icon you can launch (e.g. after Exit).
  CreateShortcut "$SMPROGRAMS\${APPNAME}.lnk" "wscript.exe" '"$INSTDIR\launch.vbs"'
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "wscript.exe" '"$INSTDIR\launch.vbs"'

  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${REGKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKLM "${REGKEY}" "Publisher" "MCMF"
  WriteRegStr HKLM "${REGKEY}" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${REGKEY}" "InstallLocation" "$INSTDIR"

  ; Launch the tray UI now (no reboot/logon needed for the first run).
  Exec 'wscript.exe "$INSTDIR\launch.vbs"'

  DetailPrint "MCMF Endpoint Agent installed. Telemetry runs as an always-on background service; the shield icon is the settings UI."
SectionEnd

Section "Uninstall"
  SetShellVarContext all
  nsExec::ExecToLog 'schtasks /end /tn "${SVCTASK}"'
  nsExec::ExecToLog 'schtasks /delete /tn "${SVCTASK}" /f'
  nsExec::ExecToLog 'schtasks /delete /tn "${APPNAME}" /f'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="MCMF Agent 9182"'
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  Delete "$DESKTOP\${APPNAME}.lnk"
  Delete "$INSTDIR\mcmf-tray-agent.ps1"
  Delete "$INSTDIR\install-service-task.ps1"
  Delete "$INSTDIR\install-logon-task.ps1"
  Delete "$INSTDIR\launch.vbs"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "${REGKEY}"
  DetailPrint "Removed the background service + tray tasks. If the tray icon is still visible, choose 'Hide icon' from its menu."
SectionEnd
