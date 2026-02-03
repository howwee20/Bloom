#!/bin/bash
# Wrapper script for Claude Desktop MCP integration.
# IMPORTANT: MCP requires JSON-RPC on stdout only. Do not write to stdout here.
set -euo pipefail

err() {
  echo "$@" >&2
}

: "${BLOOM_BASE_URL:?BLOOM_BASE_URL is required}"
: "${BLOOM_READ_KEY:?BLOOM_READ_KEY is required}"
: "${BLOOM_PROPOSE_KEY:?BLOOM_PROPOSE_KEY is required}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f "./src/mcp/server.ts" ]; then
  err "MCP server not found: ./src/mcp/server.ts"
  exit 1
fi

if [ ! -x "./node_modules/.bin/tsx" ]; then
  err "Missing tsx binary. Run: pnpm install"
  exit 1
fi

NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  err "nvm not found at $NVM_DIR/nvm.sh"
  exit 1
fi

# shellcheck disable=SC1090
. "$NVM_DIR/nvm.sh" >/dev/null 2>&1
if ! nvm use 20 >/dev/null 2>&1; then
  err "Failed to activate Node 20 via nvm"
  exit 1
fi

exec ./node_modules/.bin/tsx ./src/mcp/server.ts
