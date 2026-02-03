# ChatGPT Desktop MCP Integration

This guide explains how to connect ChatGPT Desktop to Bloom via the MCP (Model Context Protocol) gateway.

## Overview

Bloom exposes an MCP server that ChatGPT Desktop can use to:
- View agent balances and activity (`bloom_ui_state`, `bloom_ui_activity`)
- Place and cancel Polymarket dry-run orders
- Check bot status

## Quick Start (Ephemeral Tunnel)

For testing, use the ephemeral tunnel which creates a temporary URL:

```bash
# Terminal 1: Start the API server
pnpm dev

# Terminal 2: Start the MCP gateway with tunnel
export BLOOM_BASE_URL=http://localhost:3000
export BLOOM_READ_KEY=your_read_key
export BLOOM_PROPOSE_KEY=your_propose_key
pnpm mcp:chatgpt:tunnel
```

This will output a URL like `https://random-name-42.tunnel.gla.ma`. Use this URL + `/mcp` in ChatGPT.

**Note:** The URL changes every restart. For a stable URL, use Cloudflare Tunnel below.

## Stable URL Setup (Cloudflare Tunnel)

For production use, set up a permanent URL using Cloudflare Tunnel.

### Prerequisites

1. A domain managed by Cloudflare
2. `cloudflared` CLI installed

### Installation

```bash
# Install cloudflared
brew install cloudflared

# Run the setup helper (replace with your domain)
./scripts/mcp-chatgpt-stable-install.sh yourdomain.com
```

This will:
1. Log you into Cloudflare (opens browser)
2. Create a tunnel named `bloom-mcp`
3. Route `bloom-mcp.yourdomain.com` to the tunnel
4. Create the cloudflared config file

### Manual Setup (Alternative)

If you prefer manual setup:

```bash
# Login to Cloudflare
cloudflared login

# Create tunnel
cloudflared tunnel create bloom-mcp

# Route DNS (replace with your domain)
cloudflared tunnel route dns bloom-mcp bloom-mcp.yourdomain.com

# Create config at ~/.cloudflared/config.yml
# See .cloudflared/config.yml.example for template
```

### Running the Stable Gateway

```bash
# Terminal 1: Start the API server
pnpm dev

# Terminal 2: Start the stable MCP gateway
export BLOOM_BASE_URL=http://localhost:3000
export BLOOM_READ_KEY=your_read_key
export BLOOM_PROPOSE_KEY=your_propose_key
export BLOOM_MCP_PUBLIC_URL=https://bloom-mcp.yourdomain.com
pnpm mcp:chatgpt:stable
```

Your ChatGPT connector URL is: `https://bloom-mcp.yourdomain.com/mcp`

## ChatGPT Desktop Configuration

1. Open ChatGPT Desktop
2. Go to **Settings** (gear icon)
3. Navigate to **Connectors** or **Tools**
4. Click **Add MCP Connector** (or similar)
5. Enter the URL:
   - Ephemeral: `https://random-name-42.tunnel.gla.ma/mcp`
   - Stable: `https://bloom-mcp.yourdomain.com/mcp`
6. Authentication: **None**
7. Save and enable the connector

## Using Bloom in ChatGPT

Once connected, you can ask ChatGPT:

```
"Use Bloom to show the UI state for agent_ej"

"Use Bloom to show recent activity for agent_ej"

"Use Bloom to place a dry-run order on Polymarket"

"Use Bloom to check the bot status"
```

## Available Tools (ChatGPT Profile)

The ChatGPT profile exposes a restricted set of safe tools:

| Tool | Description | Read-Only |
|------|-------------|-----------|
| `bloom_ui_state` | Get agent balance, held, spendable | Yes |
| `bloom_ui_activity` | Get activity feed | Yes |
| `bloom_polymarket_dryrun_place_order` | Place dry-run order | No |
| `bloom_polymarket_dryrun_cancel_order` | Cancel dry-run order | No |
| `bloom_polymarket_bot_status` | Check bot status | Yes |

**Security Note:** The ChatGPT profile intentionally excludes admin tools, real trading tools, and key management tools.

## Local-only (no tunnel)

If you only need a local gateway (no HTTPS), run:

```bash
pnpm mcp:chatgpt
```

This exposes `http://localhost:8080/mcp`.

## Troubleshooting

### "BLOOM_BASE_URL is required"

Make sure you've exported the environment variables before starting the gateway:

```bash
export BLOOM_BASE_URL=http://localhost:3000
export BLOOM_READ_KEY=your_read_key
export BLOOM_PROPOSE_KEY=your_propose_key
```

Or add them to your `.env` file and source it:

```bash
set -a && source .env && set +a
pnpm mcp:chatgpt:tunnel
```

### "Port 8080 already in use"

Another process is using port 8080. Find and kill it:

```bash
lsof -nP -iTCP:8080 -sTCP:LISTEN
kill -9 <PID>
```

### ChatGPT doesn't call the tool

1. Make sure the connector is enabled in ChatGPT settings
2. Explicitly mention "Use Bloom" in your message
3. Select Bloom from the tools/connectors picker in the chat

### Tunnel URL changed

If using the ephemeral tunnel, you must update the ChatGPT connector URL every restart. Switch to the stable Cloudflare Tunnel for a permanent URL.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BLOOM_BASE_URL` | Yes | API server URL (e.g., `http://localhost:3000`) |
| `BLOOM_READ_KEY` | Yes | API key with `read` scope |
| `BLOOM_PROPOSE_KEY` | Yes | API key with `propose` scope |
| `BLOOM_EXECUTE_KEY` | No | API key with `execute` scope (for real trading) |
| `BLOOM_ADMIN_KEY` | No | Admin key (for bot control) |
| `BLOOM_MCP_PROFILE` | No | `chatgpt` (default) or `claude` |
| `BLOOM_MCP_PUBLIC_URL` | No | Public URL for display (e.g., `https://bloom-mcp.example.com`) |
| `MCP_PORT` | No | Local proxy port (default: 8080) |
| `CLOUDFLARED_TUNNEL_NAME` | No | Tunnel name (default: `bloom-mcp`) |
