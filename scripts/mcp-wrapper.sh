#!/bin/bash
# Wrapper script for Claude Desktop MCP integration.
# Runs MCP with Node + tsx loader to keep stdout clean for the MCP protocol.
set -euo pipefail

: "${BLOOM_BASE_URL:?BLOOM_BASE_URL is required}"
: "${BLOOM_READ_KEY:?BLOOM_READ_KEY is required}"
: "${BLOOM_PROPOSE_KEY:?BLOOM_PROPOSE_KEY is required}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
exec node --no-warnings --loader tsx src/mcp/server.ts
