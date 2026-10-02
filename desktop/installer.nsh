!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
InstallDir "$LOCALAPPDATA\Programs\${APP_FILENAME}"

!macro customInit
  ${If} ${isUpdated}
  ${AndIf} ${isForceRun}
    SetSilent normal
  ${EndIf}
!macroend

!macro customInstallMode
  ${If} ${isUpdated}
    ${If} $installMode == "all"
      StrCpy $isForceMachineInstall "1"
    ${Else}
      StrCpy $isForceCurrentInstall "1"
    ${EndIf}
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !define MUI_PAGE_CUSTOMFUNCTION_PRE ensureInstallDirectoryLeaf
!macroend

; The uninstaller rebuilds $INSTDIR from HKCU\${INSTALL_REGISTRY_KEY}\InstallLocation
; and ignores the _?= path the installer passes to it. Without this value the
; uninstaller falls back to the per-user default, so upgrading an install that
; lives anywhere else removes nothing and the installer reports the old files
; as still in place. Record the directory the user actually chose, after the
; install section has settled $INSTDIR.
!macro customInstall
  WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
  ${If} ${isUpdated}
  ${AndIf} ${isForceRun}
  ${AndIfNot} ${Silent}
    reopenUpdatedApp:
      ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" "--updated"
      ${If} $0 != "ok"
      ${AndIf} $0 != "fallback"
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "The update is installed, but Windows could not reopen ${PRODUCT_NAME}. Choose Retry to open it again." IDRETRY reopenUpdatedApp
      ${EndIf}
      HideWindow
      !insertmacro quitSuccess
  ${EndIf}
!macroend

!macro customHeader
Function ensureInstallDirectoryLeaf
  ${IfNot} ${isUpdated}
    Push $R0
    Push $R1
    Push $R2
    Push $R3
    Push $R4

    StrCpy $R0 $INSTDIR
    trimTrailingSeparator:
      StrLen $R1 $R0
      ${If} $R1 > 1
        StrCpy $R2 $R0 1 -1
        ${If} $R2 == "\"
        ${OrIf} $R2 == "/"
          StrCpy $R0 $R0 -1
          Goto trimTrailingSeparator
        ${EndIf}
      ${EndIf}

    StrLen $R1 "${APP_FILENAME}"
    StrLen $R2 $R0
    IntOp $R3 $R2 - $R1
    ${If} $R3 >= 0
      StrCpy $R4 $R0 $R1 $R3
      ${If} $R4 == "${APP_FILENAME}"
        ${If} $R3 == 0
          Goto leafPresent
        ${EndIf}
        IntOp $R3 $R3 - 1
        StrCpy $R4 $R0 1 $R3
        ${If} $R4 == "\"
        ${OrIf} $R4 == "/"
          Goto leafPresent
        ${EndIf}
      ${EndIf}
    ${EndIf}

    StrCpy $INSTDIR "$R0\${APP_FILENAME}"
    Goto leafChecked

    leafPresent:
      StrCpy $INSTDIR $R0
    leafChecked:
      Call instFilesPre
      Pop $R4
      Pop $R3
      Pop $R2
      Pop $R1
      Pop $R0
  ${EndIf}
FunctionEnd
!macroend
!endif
