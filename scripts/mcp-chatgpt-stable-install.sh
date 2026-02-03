#!/bin/bash
# One-time setup helper for Cloudflare Tunnel with Bloom MCP.
# This script guides you through creating a stable tunnel.
#
# Usage: ./scripts/mcp-chatgpt-stable-install.sh <your-domain>
# Example: ./scripts/mcp-chatgpt-stable-install.sh example.com
#
# This will create a tunnel that exposes bloom-mcp.example.com
set -euo pipefail

err() {
  echo "$@" >&2
}

if [ $# -lt 1 ]; then
  err "Usage: $0 <your-domain>"
  err "Example: $0 example.com"
  err ""
  err "This will create a Cloudflare Tunnel at: bloom-mcp.<your-domain>"
  exit 1
fi

DOMAIN="$1"
TUNNEL_NAME="bloom-mcp"
HOSTNAME="bloom-mcp.${DOMAIN}"

err "========================================="
err "Bloom MCP Cloudflare Tunnel Setup"
err "========================================="
err ""
err "This will create:"
err "  Tunnel name: $TUNNEL_NAME"
err "  Hostname: $HOSTNAME"
err ""

# Check for cloudflared
if ! command -v cloudflared &>/dev/null; then
  err "Step 1: Install cloudflared"
  err "  brew install cloudflared"
  err ""
  err "Then run this script again."
  exit 1
fi

err "Step 1: cloudflared is installed"
err ""

# Check if logged in
err "Step 2: Checking Cloudflare authentication..."
if ! cloudflared tunnel list &>/dev/null; then
  err "  Not logged in. Running: cloudflared login"
  err "  This will open a browser window."
  cloudflared login
fi
err "  Authenticated with Cloudflare"
err ""

# Check if tunnel exists
err "Step 3: Checking for existing tunnel..."
if cloudflared tunnel list | grep -q "^$TUNNEL_NAME "; then
  err "  Tunnel '$TUNNEL_NAME' already exists."
else
  err "  Creating tunnel: $TUNNEL_NAME"
  cloudflared tunnel create "$TUNNEL_NAME"
fi
err ""

# Route DNS
err "Step 4: Routing DNS to tunnel..."
err "  Adding route: $HOSTNAME -> $TUNNEL_NAME"
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME" 2>/dev/null || {
  err "  Route may already exist (this is fine)"
}
err ""

# Create config file
CLOUDFLARED_DIR="$HOME/.cloudflared"
CONFIG_FILE="$CLOUDFLARED_DIR/config.yml"

# Get tunnel UUID
TUNNEL_UUID=$(cloudflared tunnel list | grep "^$TUNNEL_NAME " | awk '{print $2}')
if [ -z "$TUNNEL_UUID" ]; then
  err "Error: Could not find tunnel UUID for '$TUNNEL_NAME'"
  exit 1
fi

err "Step 5: Creating cloudflared config..."
err "  Config file: $CONFIG_FILE"
err "  Tunnel UUID: $TUNNEL_UUID"

cat > "$CONFIG_FILE" <<EOF
tunnel: $TUNNEL_UUID
credentials-file: $CLOUDFLARED_DIR/$TUNNEL_UUID.json

ingress:
  - hostname: $HOSTNAME
    service: http://localhost:8080
  - service: http_status:404
EOF

err ""
err "========================================="
err "Setup Complete!"
err "========================================="
err ""
err "Your stable ChatGPT MCP URL will be:"
err "  https://${HOSTNAME}/mcp"
err ""
err "Add to your .env file:"
err "  BLOOM_MCP_PUBLIC_URL=https://${HOSTNAME}"
err ""
err "To start the stable gateway:"
err "  pnpm mcp:chatgpt:stable"
err ""
err "Then in ChatGPT Desktop:"
err "  1. Go to Settings > Connectors"
err "  2. Add new MCP connector"
err "  3. Enter URL: https://${HOSTNAME}/mcp"
err "  4. Auth: None"
err ""
