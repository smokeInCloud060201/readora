#!/bin/sh
# Readora macOS Safe Uninstall Data & Cache Cleanup Script
# Removes ONLY Readora's SQLite database (`readora.sqlite*`), staged library/update files,
# and cache artifacts. External user PDF documents and unrelated files are strictly preserved.
set -eu

DATA_DIR="${READORA_DATA_DIR:-$HOME/Library/Application Support/com.readora.desktop}"
CACHE_DIR="${READORA_CACHE_DIR:-$HOME/Library/Caches/com.readora.desktop}"
TMP_BASE="${TMPDIR:-/tmp}"
TMP_BASE="${TMP_BASE%/}"
TMP_SAMPLES="${TMP_BASE:-/tmp}/readora-samples"

check_no_symlink_segments() {
  target_path="$1"
  case "$target_path" in
    /*) ;;
    *) return 1 ;;
  esac
  cur=""
  rest="${target_path#/}"
  while [ -n "$rest" ]; do
    seg="${rest%%/*}"
    if [ "$seg" = "$rest" ]; then
      rest=""
    else
      rest="${rest#*/}"
    fi
    [ -n "$seg" ] || continue
    cur="$cur/$seg"
    if [ -L "$cur" ]; then
      return 1
    fi
  done
  return 0
}

is_safe_dir() {
  check_no_symlink_segments "$1" || return 1
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
    find -P "$DATA_DIR/updates" -maxdepth 2 -type f \( \
      -name "release-manifest*.json" \
      -o -name "*.dmg" \
      -o -name "*.pkg" \
      -o -name "*.zip" \
      -o -name "*.tar.gz" \
      -o -name "*.sha256" \
      -o -name "*.tmp" \
      -o -name ".*.tmp-*" \
    \) -delete 2>/dev/null || true
    find -P "$DATA_DIR/updates" -depth -mindepth 1 -type d -exec rmdir {} + 2>/dev/null || true
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

  if [ -d "$DATA_DIR/cache" ] && [ ! -L "$DATA_DIR/cache" ]; then
    for sub in thumbnails pages temp updates; do
      if [ -d "$DATA_DIR/cache/$sub" ] && [ ! -L "$DATA_DIR/cache/$sub" ]; then
        find -P "$DATA_DIR/cache/$sub" -maxdepth 2 -type f \( \
          -name "*.png" \
          -o -name "*.cache" \
          -o -name "*.tmp" \
          -o -name "*.json" \
          -o -name "*.bin" \
          -o -name ".*.tmp-*" \
        \) -delete 2>/dev/null || true
        find -P "$DATA_DIR/cache/$sub" -depth -mindepth 1 -type d -exec rmdir {} + 2>/dev/null || true
        rmdir "$DATA_DIR/cache/$sub" 2>/dev/null || true
      fi
    done
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
    find -P "$DATA_DIR/samples" -maxdepth 1 -type f \( \
      -name "Readora-Welcome-Guide.pdf" \
      -o -name "*.tmp" \
      -o -name ".*.tmp-*" \
    \) -delete 2>/dev/null || true
    rmdir "$DATA_DIR/samples" 2>/dev/null || true
  fi

  rmdir "$DATA_DIR" 2>/dev/null || true
fi

if is_safe_dir "$CACHE_DIR"; then
  for sub in render-cache thumbnails pages temp updates; do
    if [ -d "$CACHE_DIR/$sub" ] && [ ! -L "$CACHE_DIR/$sub" ]; then
      find -P "$CACHE_DIR/$sub" -maxdepth 2 -type f \( \
        -name "*.png" \
        -o -name "*.cache" \
        -o -name "*.tmp" \
        -o -name "*.json" \
        -o -name "*.bin" \
        -o -name ".*.tmp-*" \
      \) -delete 2>/dev/null || true
      find -P "$CACHE_DIR/$sub" -depth -mindepth 1 -type d -exec rmdir {} + 2>/dev/null || true
      rmdir "$CACHE_DIR/$sub" 2>/dev/null || true
    fi
  done
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
  find -P "$TMP_SAMPLES" -maxdepth 1 -type f \( \
    -name "Readora-Welcome-Guide.pdf" \
    -o -name "*.tmp" \
    -o -name ".*.tmp-*" \
  \) -delete 2>/dev/null || true
  rmdir "$TMP_SAMPLES" 2>/dev/null || true
fi
