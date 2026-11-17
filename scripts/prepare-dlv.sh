#!/usr/bin/env bash
# Ensures a Delve (dlv) binary exists for bundling into GoMavo.app.
# Reuses an existing copy; otherwise builds dlv via `go install`.
set -euo pipefail

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) EXE=".exe" ;;
  *) EXE="" ;;
esac

TARGET="src-tauri/binaries/dlv$EXE"

if [ -x "$TARGET" ]; then
  echo "dlv already present: $TARGET ($("$TARGET" version | head -1))"
  exit 0
fi

if ! command -v go >/dev/null 2>&1; then
  echo "error: Go is not installed; cannot build Delve." >&2
  echo "Install Go (https://go.dev) or place a dlv binary at $TARGET manually." >&2
  exit 1
fi

echo "Building Delve (dlv) via go install..."
go install github.com/go-delve/delve/cmd/dlv@latest

GOBIN_DIR="$(go env GOBIN 2>/dev/null || true)"
if [ -z "$GOBIN_DIR" ]; then
  GOBIN_DIR="$(go env GOPATH)/bin"
fi
SOURCE="$GOBIN_DIR/dlv$EXE"
if [ ! -f "$SOURCE" ]; then
  echo "error: dlv was not found at $SOURCE after install." >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET")"
cp "$SOURCE" "$TARGET"
chmod +x "$TARGET"

# Ship the Delve MIT license alongside the binary (redistribution attribution).
GOPATH_DIR="$(go env GOPATH)"
command -v cygpath >/dev/null 2>&1 && GOPATH_DIR="$(cygpath -u "$GOPATH_DIR")"
LICENSE_SRC="$(find "$GOPATH_DIR/pkg/mod/github.com/go-delve" -maxdepth 2 -name LICENSE 2>/dev/null | head -1 || true)"
if [ -n "$LICENSE_SRC" ]; then
  cp "$LICENSE_SRC" "src-tauri/binaries/dlv-LICENSE"
  chmod 644 "src-tauri/binaries/dlv-LICENSE"
fi
echo "dlv ready: $TARGET ($("$TARGET" version | head -1))"
