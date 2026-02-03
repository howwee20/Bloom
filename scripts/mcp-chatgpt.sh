#!/bin/bash
# Wrapper script for ChatGPT Desktop MCP gateway.
# IMPORTANT: MCP requires JSON-RPC on stdout only from the stdio server.
set -euo pipefail

err() {
  echo "$@" >&2
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -x "./node_modules/.bin/mcp-proxy" ]; then
  err "Missing mcp-proxy binary. Run: pnpm install"
  exit 1
fi

if [ ! -x "./scripts/mcp-wrapper.sh" ]; then
  err "Missing MCP wrapper: ./scripts/mcp-wrapper.sh"
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

export BLOOM_MCP_PROFILE="${BLOOM_MCP_PROFILE:-chatgpt}"

exec ./node_modules/.bin/mcp-proxy --port 8080 "$@" -- ./scripts/mcp-wrapper.sh
