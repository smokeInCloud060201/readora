#!/bin/sh
# Readora macOS Safe Uninstall Data & Cache Cleanup Script
# Removes ONLY Readora's SQLite database (`readora.sqlite*`), staged library/update files,
# and cache artifacts. External user PDF documents and unrelated files are strictly preserved.
set -eu

DATA_DIR="${READORA_DATA_DIR:-$HOME/Library/Application Support/com.readora.desktop}"
CACHE_DIR="${READORA_CACHE_DIR:-$HOME/Library/Caches/com.readora.desktop}"
TMP_SAMPLES="${TMPDIR:-/tmp}/readora-samples"

is_safe_dir() {
  [ -d "$1" ] && [ ! -L "$1" ] || return 1
  case "$(basename "$1")" in
    com.readora.desktop|Readora|readora|readora-data|readora-cache|readora-samples|readora-mem-*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

if is_safe_dir "$DATA_DIR"; then
  find -P "$DATA_DIR" -maxdepth 1 -type f \( \
    -name "readora.sqlite" \
    -o -name "readora.sqlite-wal" \
    -o -name "readora.sqlite-shm" \
    -o -name "readora.sqlite-journal" \
    -o -name ".*.tmp-*" \
  \) -delete 2>/dev/null || true

  if [ -d "$DATA_DIR/updates" ] && [ ! -L "$DATA_DIR/updates" ]; then
    find -P "$DATA_DIR/updates" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
    rmdir "$DATA_DIR/updates" 2>/dev/null || true
  fi

  if [ -d "$DATA_DIR/library" ] && [ ! -L "$DATA_DIR/library" ]; then
    if [ -d "$DATA_DIR/library/pdfs" ] && [ ! -L "$DATA_DIR/library/pdfs" ]; then
      find -P "$DATA_DIR/library/pdfs" -maxdepth 2 -type f \( \
        -name "*.pdf" \
        -o -name "*.pdf.tmp" \
        -o -name ".*.tmp-*" \
      \) -delete 2>/dev/null || true
      find -P "$DATA_DIR/library/pdfs" -mindepth 1 -maxdepth 1 -type d \
        -exec rmdir {} + 2>/dev/null || true
      rmdir "$DATA_DIR/library/pdfs" 2>/dev/null || true
    fi
    find -P "$DATA_DIR/library" -maxdepth 1 -type f \( \
      -name "state.json" \
      -o -name "state.json.tmp*" \
      -o -name ".*.tmp-*" \
    \) -delete 2>/dev/null || true
    rmdir "$DATA_DIR/library" 2>/dev/null || true
  fi

  if is_safe_dir "$DATA_DIR/cache" || { [ -d "$DATA_DIR/cache" ] && [ ! -L "$DATA_DIR/cache" ]; }; then
    find -P "$DATA_DIR/cache" -maxdepth 1 -type f \( \
      -name "*.png" \
      -o -name "*.cache" \
      -o -name "*.tmp" \
      -o -name "*.json" \
      -o -name "*.bin" \
    \) -delete 2>/dev/null || true
    rmdir "$DATA_DIR/cache" 2>/dev/null || true
  fi

  if [ -d "$DATA_DIR/samples" ] && [ ! -L "$DATA_DIR/samples" ]; then
    find -P "$DATA_DIR/samples" -maxdepth 1 -type f -name "Readora-Welcome-Guide.pdf" -delete 2>/dev/null || true
    rmdir "$DATA_DIR/samples" 2>/dev/null || true
  fi

  rmdir "$DATA_DIR" 2>/dev/null || true
fi

if is_safe_dir "$CACHE_DIR"; then
  if [ -d "$CACHE_DIR/render-cache" ] && [ ! -L "$CACHE_DIR/render-cache" ]; then
    find -P "$CACHE_DIR/render-cache" -maxdepth 1 -type f \( \
      -name "*.png" \
      -o -name "*.cache" \
      -o -name "*.bin" \
    \) -delete 2>/dev/null || true
    rmdir "$CACHE_DIR/render-cache" 2>/dev/null || true
  fi
  find -P "$CACHE_DIR" -maxdepth 1 -type f \( \
    -name "*.png" \
    -o -name "*.cache" \
    -o -name "*.tmp" \
    -o -name "*.json" \
    -o -name "*.bin" \
  \) -delete 2>/dev/null || true
  rmdir "$CACHE_DIR" 2>/dev/null || true
fi

if is_safe_dir "$TMP_SAMPLES"; then
  find -P "$TMP_SAMPLES" -maxdepth 1 -type f -name "Readora-Welcome-Guide.pdf" -delete 2>/dev/null || true
  rmdir "$TMP_SAMPLES" 2>/dev/null || true
fi
