#!/bin/bash
# Stable ChatGPT Desktop MCP gateway using Cloudflare Tunnel.
# This provides a permanent URL that survives restarts.
#
# Prerequisites:
#   brew install cloudflared
#   cloudflared login
#   cloudflared tunnel create bloom-mcp
#   cloudflared tunnel route dns bloom-mcp bloom-mcp.<your-domain>
#
# See docs/CHATGPT_DESKTOP.md for full setup instructions.
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

# Check for cloudflared
if ! command -v cloudflared &>/dev/null; then
  err "cloudflared not found. Install with: brew install cloudflared"
  err "Then run: cloudflared login"
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

# Determine the public URL
PUBLIC_URL="${BLOOM_MCP_PUBLIC_URL:-}"
if [ -z "$PUBLIC_URL" ]; then
  # Try to read from cloudflared config
  CLOUDFLARED_CONFIG="${CLOUDFLARED_CONFIG:-$HOME/.cloudflared/config.yml}"
  if [ -f "$CLOUDFLARED_CONFIG" ]; then
    # Extract hostname from config (simple grep, not full YAML parsing)
    HOSTNAME=$(grep -E '^\s*hostname:' "$CLOUDFLARED_CONFIG" | head -1 | sed 's/.*hostname:\s*//' | tr -d '"' | tr -d "'")
    if [ -n "$HOSTNAME" ]; then
      PUBLIC_URL="https://${HOSTNAME}"
    fi
  fi
fi

# Start mcp-proxy on port 8080
MCP_PORT="${MCP_PORT:-8080}"

err "Starting Bloom MCP stable gateway..."
err "  Profile: $BLOOM_MCP_PROFILE"
err "  Local port: $MCP_PORT"
if [ -n "$PUBLIC_URL" ]; then
  err "  ChatGPT connector URL: ${PUBLIC_URL}/mcp"
else
  err "  Public URL: not configured (set BLOOM_MCP_PUBLIC_URL or configure cloudflared)"
fi
err ""

# Start mcp-proxy in background
./node_modules/.bin/mcp-proxy --port "$MCP_PORT" -- ./scripts/mcp-wrapper.sh &
MCP_PID=$!

# Give mcp-proxy time to start
sleep 2

# Check if mcp-proxy is running
if ! kill -0 "$MCP_PID" 2>/dev/null; then
  err "mcp-proxy failed to start"
  exit 1
fi

err "mcp-proxy running on port $MCP_PORT (PID $MCP_PID)"
err ""

# Determine cloudflared tunnel name
TUNNEL_NAME="${CLOUDFLARED_TUNNEL_NAME:-bloom-mcp}"

# Start cloudflared tunnel
err "Starting Cloudflare Tunnel: $TUNNEL_NAME"
err "Press Ctrl+C to stop both services."
err ""

# Trap to clean up on exit
cleanup() {
  err ""
  err "Shutting down..."
  kill "$MCP_PID" 2>/dev/null || true
  wait "$MCP_PID" 2>/dev/null || true
  err "Done."
}
trap cleanup EXIT INT TERM

# Run cloudflared tunnel
cloudflared tunnel --url "http://localhost:$MCP_PORT" run "$TUNNEL_NAME"
