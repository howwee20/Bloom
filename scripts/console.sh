#!/usr/bin/env bash
set -euo pipefail

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh"
  nvm use 20 >/dev/null
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" != "20" ]; then
  echo "Node 20 required. Current: $(node -v)" >&2
  exit 1
fi

pnpm install
pnpm console:first-run
