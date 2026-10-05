#!/usr/bin/env bash
# Builds roomsd in release mode and copies it to src-tauri/binaries/roomsd-<host-triple>,
# the name Tauri's bundle.externalBin ("binaries/roomsd") expects.
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

(cd "$REPO_ROOT" && cargo build -p roomsd --release)

EXT=""
case "$TRIPLE" in *windows*) EXT=".exe" ;; esac

DEST_DIR="$DESKTOP_DIR/src-tauri/binaries"
mkdir -p "$DEST_DIR"
cp "$REPO_ROOT/target/release/roomsd$EXT" "$DEST_DIR/roomsd-$TRIPLE$EXT"
echo "build-sidecar: $DEST_DIR/roomsd-$TRIPLE$EXT"
