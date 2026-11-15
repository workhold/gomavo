#!/usr/bin/env bash
# Ensures a gopls binary exists for bundling into MG Land.app.
# Reuses an existing copy; otherwise builds gopls via `go install`.
set -euo pipefail

TARGET="src-tauri/binaries/gopls"

if [ -x "$TARGET" ]; then
  echo "gopls already present: $TARGET ($("$TARGET" version | head -1))"
  exit 0
fi

if ! command -v go >/dev/null 2>&1; then
  echo "error: Go is not installed; cannot build gopls." >&2
  echo "Install Go (https://go.dev) or place a gopls binary at $TARGET manually." >&2
  exit 1
fi

echo "Building gopls via go install..."
go install golang.org/x/tools/gopls@latest

GOBIN_DIR="$(go env GOBIN 2>/dev/null)"
if [ -z "$GOBIN_DIR" ]; then
  GOBIN_DIR="$(go env GOPATH | cut -d: -f1)/bin"
fi
SOURCE="$GOBIN_DIR/gopls"
if [ ! -x "$SOURCE" ]; then
  echo "error: gopls was not found at $SOURCE after install." >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET")"
cp "$SOURCE" "$TARGET"
chmod +x "$TARGET"

# Ship the gopls BSD license alongside the binary (redistribution attribution).
LICENSE_SRC="$(find "$(go env GOPATH | cut -d: -f1)/pkg/mod/golang.org/x/tools@"* -maxdepth 1 -name LICENSE 2>/dev/null | head -1)"
if [ -n "$LICENSE_SRC" ]; then
  cp "$LICENSE_SRC" "src-tauri/binaries/gopls-LICENSE"
  chmod 644 "src-tauri/binaries/gopls-LICENSE"
fi
echo "gopls ready: $TARGET ($("$TARGET" version | head -1))"
