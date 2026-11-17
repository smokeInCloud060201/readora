; Readora NSIS Post-Uninstall Hook
; Removes ONLY files and cache folders created by Readora.
; Never uses recursive RMDir /r on user data directories; RMDir only removes a folder if empty.

!macro NSIS_HOOK_POSTUNINSTALL
  ; 1. Remove Readora SQLite database, staged updates, library staging, and cache files in %APPDATA%\Readora
  Delete "$APPDATA\Readora\readora.sqlite"
  Delete "$APPDATA\Readora\readora.sqlite-wal"
  Delete "$APPDATA\Readora\readora.sqlite-shm"
  Delete "$APPDATA\Readora\readora.sqlite-journal"
  Delete "$APPDATA\Readora\.*.tmp-*"

  Delete "$APPDATA\Readora\updates\release-manifest.json"
  Delete "$APPDATA\Readora\updates\*.tmp"
  Delete "$APPDATA\Readora\updates\.*.tmp-*"
  RMDir "$APPDATA\Readora\updates"

  ClearErrors
  FindFirst $0 $1 "$APPDATA\Readora\library\pdfs\*"
  loop_library_pdfs:
    IfErrors done_library_pdfs
    StrCmp $1 "." next_library_pdf
    StrCmp $1 ".." next_library_pdf
    IfFileExists "$APPDATA\Readora\library\pdfs\$1\*.*" 0 next_library_pdf
      Delete "$APPDATA\Readora\library\pdfs\$1\*.pdf"
      Delete "$APPDATA\Readora\library\pdfs\$1\*.pdf.tmp"
      Delete "$APPDATA\Readora\library\pdfs\$1\.*.tmp-*"
      RMDir "$APPDATA\Readora\library\pdfs\$1"
    next_library_pdf:
      FindNext $0 $1
      Goto loop_library_pdfs
  done_library_pdfs:
  FindClose $0

  Delete "$APPDATA\Readora\library\pdfs\*.pdf"
  Delete "$APPDATA\Readora\library\pdfs\*.pdf.tmp"
  Delete "$APPDATA\Readora\library\pdfs\.*.tmp-*"
  RMDir "$APPDATA\Readora\library\pdfs"
  Delete "$APPDATA\Readora\library\state.json"
  Delete "$APPDATA\Readora\library\state.json.tmp*"
  Delete "$APPDATA\Readora\library\.*.tmp-*"
  RMDir "$APPDATA\Readora\library"

  Delete "$APPDATA\Readora\cache\*.png"
  Delete "$APPDATA\Readora\cache\*.cache"
  Delete "$APPDATA\Readora\cache\*.tmp"
  Delete "$APPDATA\Readora\cache\*.json"
  Delete "$APPDATA\Readora\cache\*.bin"
  RMDir "$APPDATA\Readora\cache"
  RMDir "$APPDATA\Readora"

  ; 2. Remove Readora cache files in %LOCALAPPDATA%\Readora\Cache
  Delete "$LOCALAPPDATA\Readora\Cache\render-cache\*.png"
  Delete "$LOCALAPPDATA\Readora\Cache\render-cache\*.cache"
  Delete "$LOCALAPPDATA\Readora\Cache\render-cache\*.bin"
  RMDir "$LOCALAPPDATA\Readora\Cache\render-cache"
  Delete "$LOCALAPPDATA\Readora\Cache\*.png"
  Delete "$LOCALAPPDATA\Readora\Cache\*.cache"
  Delete "$LOCALAPPDATA\Readora\Cache\*.tmp"
  Delete "$LOCALAPPDATA\Readora\Cache\*.json"
  Delete "$LOCALAPPDATA\Readora\Cache\*.bin"
  RMDir "$LOCALAPPDATA\Readora\Cache"
  RMDir "$LOCALAPPDATA\Readora"
!macroend
