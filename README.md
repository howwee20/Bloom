# Bloom Constraint Kernel v0

Provider-agnostic constraint runtime for agents in a persistent environment.

Key rules
- Fail closed by default: if environment freshness is stale/unknown, `can_do` and `execute` are rejected; `execute` may be overridden via `override_freshness`.
- Irreversible truth: append-only event log with hash chaining.
- Idempotent and auditable: quotes, executions, receipts, and deterministic env state.
- Consequences without suffering: loss of future options, budget, or time (no “pain”).
- Growth definition (v0): improved performance on novel tasks + improved calibration + fewer catastrophes over time, not just higher win-rate on a fixed set.

## Kernel Contract (v0.1.0-alpha)

This contract defines the stable syscall surface and invariants for the kernel. Changes require a version bump.

Kernel laws
- Membrane: external side effects only occur via environment actions; authoritative kernel mutations are logged via events/receipts (derived caches may update without their own events).
- Append-only: events and receipts are immutable; new truth is additive.
- Receipts are immutable: corrections are appended as new receipts (no mutation).
- Deterministic replay: replaying the event log yields the same state and receipts.
- Idempotency: repeated calls with the same idempotency key do not create duplicate effects.
- Conservative bounds: spend power uses the tightest applicable limits (policy, balance, reserves).
- Fail-closed: stale/unknown environment freshness rejects `can_do` and `execute`; `execute` may be explicitly overridden with `override_freshness`.
- Sovereignty: agents are isolated; policy/budget state never crosses agent boundaries.
- Grounded receipts: every receipt references causal facts (event + snapshot) for auditability.

Public API surfaces (stable response fields)
- `GET /healthz` -> `api_version`, `db_connected`, `migrations_applied`, `card_mode`, `env_type`, `git_sha`
- `GET /api/whoami` -> `user_id`, `key_id`, `scopes`
- `POST /api/agents` -> `user_id`, `agent_id`
- `POST /api/can_do` -> `quote_id`, `allowed`, `requires_step_up`, `reason`, `expires_at`, `idempotency_key`
- `POST /api/execute` -> `status`, `exec_id?`, `external_ref?`, `reason?`
- `POST /api/step_up/request` -> `challenge_id`, `approval_url`, `expires_at`
- `GET /api/state` -> `agent_id`, `status`, `observation`, `env_freshness`, `spend_power?`
- `GET /api/receipts` -> `receipts` (array of receipt rows)
- `GET /api/agents/:agent_id/summary` -> `total_spent_cents`, `confirmed_balance_cents`, `reserved_outgoing_cents`, `effective_spend_power_cents`, `last_receipts`
- `GET /api/agents/:agent_id/timeline` -> `timeline` items with `{ id, ts, kind, type, ... }`
  - receipt items: `what_happened`, `why_changed`, `what_happens_next`, `event_id`, `external_ref`
  - event items: `payload`
- `GET /api/agents/:agent_id/receipt/:receipt_id` -> `receipt`, `facts_snapshot`, `event`
- `POST /api/card/auth` -> `approved`, `shadow`, `would_approve?`, `would_decline_reason?`, `auth_status?`, `idempotent?`
- `POST /api/card/settle` -> `ok`, `idempotent?`
- `POST /api/card/release` -> `ok`, `idempotent?`
- `POST /api/freeze` -> `ok`, `reason?`
- `POST /api/revoke_token` -> `ok`, `reason?`
- `GET /api/truth_console` -> `state`, `env_freshness`, `budget`, `recent_receipts`
- `POST /api/admin/keys` -> `key_id`, `user_id`, `api_key`, `scopes`
- `POST /api/admin/keys/revoke` -> `ok`

Not in contract
- Client SDKs, CLI tooling, or example apps.
- The approval UI or any other web UI.
- Provider-specific payload shapes (e.g., Base USDC receipts or card metadata beyond declared fields).
- Internal DB schemas, migrations, or log formatting.

## Docker Quickstart (Recommended)

The one true way to run the kernel. Works on any machine with Docker Desktop.

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running

### Run the Kernel

```bash
git clone https://github.com/howwee20/Bloom.git
cd Bloom
cp .env.example .env
docker compose up -d --build
```

### Verify Healthy

Wait ~30 seconds for first build, then:

```bash
curl http://localhost:3000/healthz
```

Expected output:

```json
{"api_version":"0.1.0-alpha","db_connected":true,"migrations_applied":true,"card_mode":"dev","env_type":"base_usdc","git_sha":null}
```

## Bloom Console (Reference Client v0)

The console is a lightweight web client that talks to the kernel via the public API and uses Claude Sonnet as the planner. It does **not** modify kernel behavior.

### Prerequisites

- Set `ANTHROPIC_API_KEY` in `.env`
- Optional: set `CONSOLE_BOOTSTRAP_TOKEN` to require a bootstrap code for new accounts

### Run

```bash
pnpm dev
```

Open `http://localhost:3000/console`.

### Notes

- "Create Bloom" uses a local bootstrap endpoint to mint a user, agent, and API key.
- "Add money" shows the agent wallet address (Base USDC env).
- The assistant only proposes actions; execution always requires explicit approval.
```json
{
  "api_version": "0.1.0-alpha",
  "db_connected": true,
  "migrations_applied": true,
  "card_mode": "dev",
  "env_type": "base_usdc",
  "git_sha": "..."
}
```

**What "healthy" means:**
- `db_connected: true` - SQLite database is accessible
- `migrations_applied: true` - Schema is up to date
- API is listening on `0.0.0.0:3000`

### Ports and Persistence

| Port | Service |
|------|---------|
| 3000 | Kernel API |
| 3001 | Approval UI (if `BIND_APPROVAL_UI=true`) |

Data persists in Docker volume `bloom_data`. Database path inside container: `/data/kernel.db`.

### Shut Down and Wipe Data

```bash
docker compose down           # Stop containers (data persists)
docker compose down --volumes # Stop and DELETE all data
```

### Smoke Test

Run the full end-to-end test:

```bash
./scripts/docker_smoke.sh
```

Expected final output: `=== SMOKE TEST PASSED ===`

## Local Development Quickstart

For development without Docker:

### Prerequisites

- **Node.js 20.x or 22.x** (NOT Node 24 - causes native module issues)
- **pnpm** (installed via corepack)

```bash
# Use correct Node version (check .nvmrc)
nvm use

# Verify versions
node -v    # Should show v20.x or v22.x
pnpm -v    # Should show 9.x or 10.x

# If pnpm is missing:
corepack enable
corepack prepare pnpm@latest --activate
```

### Setup

```bash
# Install dependencies (rebuilds native modules for your Node version)
pnpm install

# Copy environment file
cp .env.example .env

# Run migrations
pnpm migrate

# Validate environment
pnpm doctor

# Start server
pnpm dev
```

### Troubleshooting

If you see `NODE_MODULE_VERSION` errors (e.g., "compiled against 115, requires 137"):

```bash
# You're running the wrong Node version. Fix:
nvm use 20
rm -rf node_modules
pnpm install
```

If `tsx: command not found`:

```bash
# Dependencies didn't install properly. Fix:
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

## Env vars

- `API_VERSION` (default `0.1.0-alpha`)
- `DB_PATH` (default `./data/kernel.db`)
- `PORT` (default `3000`)
- `APPROVAL_UI_PORT` (default `3001`)
- `BIND_APPROVAL_UI` (`true` to enable localhost approval UI, default `false`)
- `CARD_MODE` (`dev` | `shadow` | `enforce`, default `dev`)
- `CARD_WEBHOOK_SHARED_SECRET` (required when `CARD_MODE` is `shadow` or `enforce`)
- `ADMIN_API_KEY` (optional; protects `/api/truth_console` via `x-admin-key`)
- `ENV_TYPE` (`simple_economy` | `base_usdc`, default `simple_economy`)
- `ENV_STALE_SECONDS` (default `60`)
- `ENV_UNKNOWN_SECONDS` (default `300`)
- `STEP_UP_SHARED_SECRET` (legacy; no longer used for step-up gating)
- `STEP_UP_CHALLENGE_TTL_SECONDS` (default `120`)
- `STEP_UP_TOKEN_TTL_SECONDS` (default `60`)
- `DEFAULT_CREDITS_CENTS` (default `5000`)
- `DEFAULT_DAILY_SPEND_CENTS` (default `2000`)
- `BASE_RPC_URL` (required when `ENV_TYPE=base_usdc`)
- `BASE_CHAIN` (`base` | `base_sepolia`, default `base_sepolia`)
- `BASE_USDC_CONTRACT` (required when `ENV_TYPE=base_usdc`)
- `CONFIRMATIONS_REQUIRED` (default `5`)
- `USDC_BUFFER_CENTS` (default `0`)
- `DEV_MASTER_MNEMONIC` (required when `ENV_TYPE=base_usdc`; **insecure dev-only**)
- `BLOOM_BASE_URL` (MCP server base URL)
- `BLOOM_READ_KEY` (MCP read-only key)
- `BLOOM_PROPOSE_KEY` (MCP propose-only key)

## API examples

```bash
curl -s -X POST http://localhost:3000/api/agents \
  -H 'content-type: application/json' \
  -d '{"user_id":"user_1","agent_id":"agent_1"}'

curl -s -X POST http://localhost:3000/api/can_do \
  -H 'content-type: application/json' \
  -d '{"user_id":"user_1","agent_id":"agent_1","intent_json":{"type":"request_job"}}'

curl -s -X POST http://localhost:3000/api/execute \
  -H 'content-type: application/json' \
  -d '{"quote_id":"QUOTE_ID","idempotency_key":"IDEMPOTENCY_KEY"}'

curl -s 'http://localhost:3000/api/state?agent_id=agent_1'

curl -s 'http://localhost:3000/api/receipts?agent_id=agent_1'

curl -s -X POST http://localhost:3000/api/freeze \
  -H 'content-type: application/json' \
  -d '{"agent_id":"agent_1","reason":"manual"}'

curl -s 'http://localhost:3000/api/truth_console?agent_id=agent_1' \
  -H 'x-admin-key: YOUR_ADMIN_API_KEY'
```

## Step-up approvals (localhost UI)

Base USDC transfers now require a step-up token minted out-of-band on localhost.

1) Enable the approval UI:
```bash
export BIND_APPROVAL_UI=true
export APPROVAL_UI_PORT=3001
```

2) Request a step-up challenge (OWNER scope required).
```bash
curl -s -X POST http://localhost:3000/api/step_up/request \
  -H 'content-type: application/json' \
  -H 'x-api-key: OWNER_API_KEY' \
  -d '{"agent_id":"AGENT_ID","quote_id":"QUOTE_ID"}'
```

3) Open the returned `approval_url` on the same machine (127.0.0.1). A 6-digit code is printed to server stdout.

4) Execute with the minted token:
```bash
curl -s -X POST http://localhost:3000/api/execute \
  -H 'content-type: application/json' \
  -H 'x-api-key: EXECUTE_API_KEY' \
  -H 'x-step-up: STEP_UP_TOKEN' \
  -d '{"quote_id":"QUOTE_ID","idempotency_key":"IDEMPOTENCY_KEY"}'
```

## Chat-first read endpoints

```bash
curl -s 'http://localhost:3000/api/agents/AGENT_ID/summary?window=7d' \
  -H 'x-api-key: READ_API_KEY'

curl -s 'http://localhost:3000/api/agents/AGENT_ID/timeline?since=0&limit=50' \
  -H 'x-api-key: READ_API_KEY'

curl -s 'http://localhost:3000/api/agents/AGENT_ID/receipt/RECEIPT_ID' \
  -H 'x-api-key: READ_API_KEY'
```

## CardWorld shadow mode

Shadow mode always approves, but logs `would_approve` vs `would_decline` with the spend snapshot used.

```bash
curl -s -X POST http://localhost:3000/api/card/auth \
  -H 'content-type: application/json' \
  -d '{"auth_id":"auth_1","card_id":"card_1","agent_id":"AGENT_ID","merchant":"Test","mcc":"5812","amount_cents":500,"currency":"USD","timestamp":1700000000}'
```

## Claude Desktop MCP Quickstart

The MCP server enables Claude Desktop to read agent state and propose actions. By design, **Claude cannot execute transactions** - humans approve out-of-band.

### Available MCP Tools

| Tool | Description | Scope Required |
|------|-------------|----------------|
| `bloom_get_state` | Fetch agent state and observation | read |
| `bloom_list_receipts` | List receipts for an agent | read |
| `bloom_can_do` | Request a quote (propose only) | propose |

No `execute` tool is exposed. This is intentional.

### Step 1: Create Scoped API Keys

The MCP server requires two separate keys with minimal scopes:

```bash
# Create read-only key
curl -s -X POST http://localhost:3000/api/admin/keys \
  -H 'content-type: application/json' \
  -H 'x-admin-key: YOUR_ADMIN_API_KEY' \
  -d '{"user_id":"mcp_user","scopes":["read"]}'

# Create propose-only key
curl -s -X POST http://localhost:3000/api/admin/keys \
  -H 'content-type: application/json' \
  -H 'x-admin-key: YOUR_ADMIN_API_KEY' \
  -d '{"user_id":"mcp_user","scopes":["propose"]}'
```

Save both `api_key` values from the responses.

### Step 2: Configure Claude Desktop

Edit your Claude Desktop config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "bloom": {
      "command": "bash",
      "args": [
        "-lc",
        "export NVM_DIR=\"$HOME/.nvm\"; [ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\"; nvm use 20 >/dev/null; cd /path/to/Bloom; node --no-warnings --loader tsx src/mcp/server.ts"
      ],
      "env": {
        "BLOOM_BASE_URL": "http://localhost:3000",
        "BLOOM_READ_KEY": "your_read_only_api_key",
        "BLOOM_PROPOSE_KEY": "your_propose_only_api_key"
      }
    }
  }
}
```

Replace `/path/to/Bloom` with your actual repo path. This avoids pnpm/tsx banners on stdout, keeping the MCP protocol clean.

### Step 3: Restart Claude Desktop

Quit and reopen Claude Desktop. The MCP server logs to stderr:
```
Bloom MCP ready | http://localhost:3000
```

### First 3 Prompts to Try

Once configured, ask Claude:

1. **"Show spend summary for agent_ej"**
   - Uses `bloom_get_state` to fetch current observation and spend power

2. **"List last 10 receipts for agent_ej"**
   - Uses `bloom_list_receipts` to show transaction history

3. **"Can agent_ej send $1.00 to 0x1111111111111111111111111111111111111111?"**
   - Uses `bloom_can_do` to check if transfer is allowed
   - Returns a quote with `allowed: true/false`
   - Does NOT execute - human approval required out-of-band

### MCP Smoke Test

Verify MCP is working (requires kernel running and scoped keys in `.env`):

```bash
export BLOOM_AGENT_ID=your_agent_id
pnpm mcp:smoke
```

Expected output: JSON with agent state.

### Troubleshooting

**MCP not connecting**
- Ensure Claude Desktop is fully quit and restarted after config changes
- Check that `cwd` path exists and contains `package.json`

**"BLOOM_BASE_URL_required" or similar**
- All three env vars are required: `BLOOM_BASE_URL`, `BLOOM_READ_KEY`, `BLOOM_PROPOSE_KEY`
- Check for typos in the config file

**"READ_KEY_scope_too_permissive"**
- The read key must have ONLY `["read"]` scope
- Keys with `propose`, `execute`, `owner`, or `*` are rejected
- Create a new key with minimal scope

**"PROPOSE_KEY_scope_too_permissive"**
- The propose key must have ONLY `["propose"]` scope (or `["read", "propose"]`)
- Keys with `execute`, `owner`, or `*` are rejected

**Server not running / connection refused**
- Ensure kernel is running: `curl http://localhost:3000/healthz`
- If using Docker: `docker compose up -d`

**Wrong port**
- Default is 3000. If you changed `PORT` in `.env`, update `BLOOM_BASE_URL` to match

**MCP tools not appearing in Claude**
- Open Claude Desktop settings and verify "bloom" server is listed
- Check Claude Desktop logs for MCP errors
- Try running `pnpm mcp` directly to see startup errors

## Replay verifier

```bash
pnpm replay --agent_id=agent_1
```

## Lithic Integration (Card Sandbox)

Scripts for testing card authorization flows with Lithic sandbox.

### Prerequisites

Add to your `.env`:
```bash
LITHIC_API_KEY=your_sandbox_api_key
PUBLIC_BLOOM_URL=https://your-ngrok-url.ngrok.app
```

### Commands

```bash
# Bootstrap: enrolls ASA endpoint with Lithic, retrieves HMAC secret
pnpm lithic:bootstrap

# Create card: creates a virtual card in Lithic sandbox
pnpm lithic:card:create

# Simulate: runs 100 auth simulations through the card
pnpm lithic:simulate:100
```

Scripts automatically load `.env` - no need to source manually.

## Run Base USDC reconciliation worker

The reconcile worker finalizes pending USDC transfers by polling Base for transaction receipts and appending
system events. It updates `base_usdc_pending_txs` statuses so reserved outgoing balances drop after confirmation
or on-chain reverts. Policy budgets are **not** refunded automatically.

```bash
pnpm worker:base_usdc
```

## Tiny SDK + agent runner

SDK lives in `packages/sdk` with a minimal `BloomClient`. Example runner:

```bash
export BLOOM_API_URL=http://localhost:3000
export BLOOM_API_KEY=YOUR_API_KEY
export USDC_TO_ADDRESS=0x1111111111111111111111111111111111111111
pnpm tsx examples/agent_runner.ts
```

## Alpha runbook (Base Sepolia)

1) Start the API and worker.
```bash
cp .env.example .env
docker compose up --build
```

2) Mint a user API key.
```bash
curl -s -X POST http://localhost:3000/api/admin/keys \
  -H 'content-type: application/json' \
  -H 'x-admin-key: YOUR_ADMIN_API_KEY' \
  -d '{"user_id":"user_alpha"}'
```

3) Create an agent, then fetch its deposit address.
```bash
curl -s -X POST http://localhost:3000/api/agents \
  -H 'content-type: application/json' \
  -H 'x-api-key: YOUR_USER_API_KEY'

curl -s 'http://localhost:3000/api/state?agent_id=AGENT_ID' \
  -H 'x-api-key: YOUR_USER_API_KEY'
```

4) Fund the agent’s address on Base Sepolia with USDC and a small amount of ETH for gas.

5) Execute a USDC transfer.
```bash
curl -s -X POST http://localhost:3000/api/can_do \
  -H 'content-type: application/json' \
  -H 'x-api-key: YOUR_USER_API_KEY' \
  -d '{"agent_id":"AGENT_ID","intent_json":{"type":"usdc_transfer","to_address":"0x1111111111111111111111111111111111111111","amount_cents":100}}'

curl -s -X POST http://localhost:3000/api/step_up/request \
  -H 'content-type: application/json' \
  -H 'x-api-key: OWNER_API_KEY' \
  -d '{"agent_id":"AGENT_ID","quote_id":"QUOTE_ID"}'

curl -s -X POST http://localhost:3000/api/execute \
  -H 'content-type: application/json' \
  -H 'x-api-key: YOUR_USER_API_KEY' \
  -H 'x-step-up: STEP_UP_TOKEN' \
  -d '{"quote_id":"QUOTE_ID","idempotency_key":"IDEMPOTENCY_KEY"}'
```
