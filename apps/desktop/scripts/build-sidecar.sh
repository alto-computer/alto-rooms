#!/usr/bin/env bash
# Builds roomsd, rooms-mcp, rooms-collect and rooms-sort in release mode and copies them to
# src-tauri/binaries/<name>-<host-triple>, the names Tauri's bundle.externalBin expects.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DESKTOP_DIR/../.." && pwd)"

if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

TRIPLE="$(rustc -vV | sed -n 's/host: //p')"
if [ -z "$TRIPLE" ]; then
  echo "build-sidecar: could not read host triple from rustc -vV" >&2
  exit 1
fi

(cd "$REPO_ROOT" && cargo build -p roomsd -p rooms-mcp -p rooms-collect -p rooms-sort --release)

EXT=""
case "$TRIPLE" in *windows*) EXT=".exe" ;; esac

DEST_DIR="$DESKTOP_DIR/src-tauri/binaries"
mkdir -p "$DEST_DIR"
for BIN in roomsd rooms-mcp rooms-collect rooms-sort; do
  # install, not cp: cp onto an existing file keeps its mode, and a non-executable sidecar never starts.
  install -m 755 "$REPO_ROOT/target/release/$BIN$EXT" "$DEST_DIR/$BIN-$TRIPLE$EXT"
  echo "build-sidecar: $DEST_DIR/$BIN-$TRIPLE$EXT"
done
