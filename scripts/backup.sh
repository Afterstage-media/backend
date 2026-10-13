#!/usr/bin/env sh
set -eu
ROOT="${BACKUP_ROOT:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$ROOT/$STAMP"
DATA_DIR="${DATA_DIR:-./data}"
UPLOAD_DIR="${UPLOAD_DIR:-./uploads}"
[ -d "$DATA_DIR" ] && cp -a "$DATA_DIR" "$ROOT/$STAMP/data" || true
[ -d "$UPLOAD_DIR" ] && cp -a "$UPLOAD_DIR" "$ROOT/$STAMP/uploads" || true
tar -czf "$ROOT/medio-under-$STAMP.tar.gz" -C "$ROOT/$STAMP" .
rm -rf "$ROOT/$STAMP"
echo "Backup creado en $ROOT/medio-under-$STAMP.tar.gz"
