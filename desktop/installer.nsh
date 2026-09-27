!ifndef BUILD_UNINSTALLER
!include LogicLib.nsh

InstallDir "$LOCALAPPDATA\Programs\${APP_FILENAME}"

!macro customPageAfterChangeDir
  !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !define MUI_PAGE_CUSTOMFUNCTION_PRE ensureInstallDirectoryLeaf
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
