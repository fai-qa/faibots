; Extra installer steps. electron-builder includes this file automatically.

; "Start when you sign in" adds a Run entry for FaiBots. Remove it when FaiBots is uninstalled, so
; Windows does not try to start a program that is gone. Skipped during an upgrade: the new version
; re-adds the entry itself on its first start (it follows the saved setting).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.faibots.app"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.faibots.app"
  ${endIf}
!macroend
