; Readora NSIS Post-Uninstall Hook
; Removes ONLY files and cache folders created by Readora.
; Never uses recursive RMDir /r on user data directories; RMDir only removes a folder if empty.

!macro NSIS_HOOK_POSTUNINSTALL
  ; 1. Remove Readora SQLite database files in %APPDATA%\Readora
  Delete "$APPDATA\Readora\readora.sqlite"
  Delete "$APPDATA\Readora\readora.sqlite-wal"
  Delete "$APPDATA\Readora\readora.sqlite-shm"
  Delete "$APPDATA\Readora\readora.sqlite-journal"
  Delete "$APPDATA\Readora\cache\*.png"
  Delete "$APPDATA\Readora\cache\*.cache"
  Delete "$APPDATA\Readora\cache\*.tmp"
  Delete "$APPDATA\Readora\cache\*.json"
  RMDir "$APPDATA\Readora\cache"
  RMDir "$APPDATA\Readora"

  ; 2. Remove Readora cache files in %LOCALAPPDATA%\Readora\Cache
  Delete "$LOCALAPPDATA\Readora\Cache\render-cache\*.png"
  Delete "$LOCALAPPDATA\Readora\Cache\render-cache\*.cache"
  RMDir "$LOCALAPPDATA\Readora\Cache\render-cache"
  Delete "$LOCALAPPDATA\Readora\Cache\*.png"
  Delete "$LOCALAPPDATA\Readora\Cache\*.cache"
  Delete "$LOCALAPPDATA\Readora\Cache\*.tmp"
  Delete "$LOCALAPPDATA\Readora\Cache\*.json"
  RMDir "$LOCALAPPDATA\Readora\Cache"
  RMDir "$LOCALAPPDATA\Readora"
!macroend
