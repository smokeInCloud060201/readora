#!/bin/sh
# Readora macOS Safe Uninstall Data & Cache Cleanup Script
# Removes ONLY Readora's SQLite database (`readora.sqlite*`) and cache artifacts.
# User PDF documents and any unrelated files are strictly preserved.
set -eu

DATA_DIR="${READORA_DATA_DIR:-$HOME/Library/Application Support/com.readora.desktop}"
CACHE_DIR="${READORA_CACHE_DIR:-$HOME/Library/Caches/com.readora.desktop}"
TMP_SAMPLES="${TMPDIR:-/tmp}/readora-samples"

if [ -d "$DATA_DIR" ]; then
  rm -f "$DATA_DIR/readora.sqlite" \
        "$DATA_DIR/readora.sqlite-wal" \
        "$DATA_DIR/readora.sqlite-shm" \
        "$DATA_DIR/readora.sqlite-journal"
  if [ -d "$DATA_DIR/cache" ]; then
    rm -f "$DATA_DIR/cache/"*.png "$DATA_DIR/cache/"*.cache "$DATA_DIR/cache/"*.tmp "$DATA_DIR/cache/"*.json 2>/dev/null || true
    rmdir "$DATA_DIR/cache" 2>/dev/null || true
  fi
  rmdir "$DATA_DIR" 2>/dev/null || true
fi

if [ -d "$CACHE_DIR" ]; then
  if [ -d "$CACHE_DIR/render-cache" ]; then
    rm -f "$CACHE_DIR/render-cache/"*.png "$CACHE_DIR/render-cache/"*.cache 2>/dev/null || true
    rmdir "$CACHE_DIR/render-cache" 2>/dev/null || true
  fi
  rm -f "$CACHE_DIR/"*.png "$CACHE_DIR/"*.cache "$CACHE_DIR/"*.tmp "$CACHE_DIR/"*.json 2>/dev/null || true
  rmdir "$CACHE_DIR" 2>/dev/null || true
fi

if [ -d "$TMP_SAMPLES" ]; then
  rm -f "$TMP_SAMPLES/Readora-Welcome-Guide.pdf" 2>/dev/null || true
  rmdir "$TMP_SAMPLES" 2>/dev/null || true
fi
