# Bloom Constraint Kernel v0

Provider-agnostic constraint runtime for agents in a persistent environment.

Key rules
- Fail closed by default: if environment freshness is stale/unknown, execution is rejected unless `override_freshness` is explicitly set.
- Irreversible truth: append-only event log with hash chaining.
- Idempotent and auditable: quotes, executions, receipts, and deterministic env state.
- Consequences without suffering: loss of future options, budget, or time (no “pain”).
- Growth definition (v0): improved performance on novel tasks + improved calibration + fewer catastrophes over time, not just higher win-rate on a fixed set.

## Kernel Contract (v0.1.0-alpha)

This contract defines the stable syscall surface and invariants for the kernel. Changes require a version bump.

Kernel laws
- Membrane: external side effects only occur via environment actions; kernel state changes only via events/receipts.
- Append-only: events and receipts are immutable; new truth is additive.
- Deterministic replay: replaying the event log yields the same state and receipts.
- Idempotency: repeated calls with the same idempotency key do not create duplicate effects.
- Conservative bounds: spend power uses the tightest applicable limits (policy, balance, reserves).
- Fail-closed: stale/unknown environment freshness rejects execution unless explicitly overridden.
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


## UX Semantics (Client Layer)

The kernel stays precise; the UI layer translates.

Canonical user terms
- Big number: spendable now (no label), e.g. "$6.00"
- Balance: confirmed total, e.g. "$8.00 balance"
- Held: reserved outgoing + holds + buffer, e.g. "$2.00 held"
- Net worth: currently equals balance, e.g. "$8.00"

Three depths of receipts
- Glance: one-line activity items ("Sent $1.00 · 0x56B0…3351 · Pending")
- Summary: 3–4 steps (Approved → Held → Sent → Confirmed)
- Full audit: raw receipts (developer mode)

UI endpoints (read key)
- `GET /api/ui/state?agent_id=...`
- `GET /api/ui/activity?agent_id=...&limit=...`
- `GET /api/ui/activity?agent_id=...&mode=full` (raw receipts)

Example curl
```bash
curl -s 'http://localhost:3000/api/ui/state?agent_id=AGENT_ID' \
  -H 'x-api-key: READ_API_KEY'

curl -s 'http://localhost:3000/api/ui/activity?agent_id=AGENT_ID&limit=10' \
  -H 'x-api-key: READ_API_KEY'

curl -s 'http://localhost:3000/api/ui/activity?agent_id=AGENT_ID&mode=full' \
  -H 'x-api-key: READ_API_KEY'
```

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

```bash
pnpm install
pnpm migrate
pnpm dev
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
- `BLOOM_ALLOW_TRANSFER` (`true` to allow `usdc_transfer` intents for explicitly allowlisted agents; default `false`)
- `BLOOM_ALLOW_TRANSFER_AGENT_IDS` (comma-separated agent ids allowed to transfer, e.g. `agent_ej`)
- `BLOOM_ALLOW_TRANSFER_TO` (comma-separated recipient addresses allowed for transfers; optional)
- `BLOOM_AUTO_APPROVE_TRANSFER_MAX_CENTS` (auto-approve transfers up to this amount, e.g. `200`)
- `BLOOM_AUTO_APPROVE_AGENT_IDS` (comma-separated agent ids allowed for auto-approve)
- `BLOOM_AUTO_APPROVE_TO` (comma-separated recipient addresses allowed for auto-approve; optional)
- `BLOOM_ALLOW_POLYMARKET` (`true` to allow Polymarket dry-run intents for explicitly allowlisted agents; default `false`)
- `BLOOM_ALLOW_POLYMARKET_AGENT_IDS` (comma-separated agent ids allowed to place/cancel dry-run orders)
- `POLY_DRYRUN_MAX_PER_ORDER_CENTS` (default `500`)
- `POLY_DRYRUN_MAX_OPEN_HOLDS_CENTS` (default `2000`)
- `POLY_DRYRUN_MAX_OPEN_ORDERS` (default `20`)
- `POLY_DRYRUN_LOOP_SECONDS` (default `30`)
- `BLOOM_BASE_URL` (MCP server base URL)
- `BLOOM_READ_KEY` (MCP read-only key)
- `BLOOM_PROPOSE_KEY` (MCP propose-only key)
- `BLOOM_EXECUTE_KEY` (optional MCP execute-only key)

**Dev transfer allowlist**

To enable USDC transfers for a specific agent during development:

```bash
export BLOOM_ALLOW_TRANSFER=true
export BLOOM_ALLOW_TRANSFER_AGENT_IDS=agent_ej
# Optional recipient allowlist
export BLOOM_ALLOW_TRANSFER_TO=0x56B0e5Ce4f03a82B5e46ACaE4e93e49Ada453351
```

Canonical intent type is `usdc_transfer` (aliases: `send_usdc`, `base_usdc_transfer`, `base_usdc_send`).

To auto-approve small transfers for the allowlisted agent/recipient:

```bash
export BLOOM_AUTO_APPROVE_TRANSFER_MAX_CENTS=200
export BLOOM_AUTO_APPROVE_AGENT_IDS=agent_ej
export BLOOM_AUTO_APPROVE_TO=0x56B0e5Ce4f03a82B5e46ACaE4e93e49Ada453351
```

## Polymarket driver (Phase 1 dry-run)

Phase 1 is a dry-run-only driver: no Polymarket API calls and no trading. It enforces policy gates, spend power bounds,
open-hold limits, idempotency, and emits receipts for each step.

**Env vars**

```bash
export BLOOM_ALLOW_POLYMARKET=true
export BLOOM_ALLOW_POLYMARKET_AGENT_IDS=agent_ej
export POLY_DRYRUN_MAX_PER_ORDER_CENTS=500
export POLY_DRYRUN_MAX_OPEN_HOLDS_CENTS=2000
export POLY_DRYRUN_MAX_OPEN_ORDERS=20
export POLY_DRYRUN_LOOP_SECONDS=30
```

**Run server / worker**

```bash
pnpm dev
# If ENV_TYPE=base_usdc, run the reconciliation worker too:
pnpm worker:base_usdc
```

**Claude Desktop MCP examples**

Example prompts (after adding MCP keys to Claude Desktop config):

- "Place a polymarket dry-run BUY order: market=test_market token=YES_123 price=0.42 size=10 for agent_ej"
- "Cancel a polymarket dry-run order: order_id=ORDER_ID for agent_ej"
- "Start polymarket dryrun bot for agent_ej"
- "Show polymarket dryrun bot status"

Bot start/stop requires `BLOOM_ADMIN_KEY` in the MCP server environment.

**CLI**

```bash
pnpm polymarket:dryrun --agent agent_ej --market "test_market" --token "YES_123" --price 0.42 --size 10 --client_order_id demo_1
pnpm polymarket:cancel --agent agent_ej --order_id ORDER_ID
```

The CLIs use `BLOOM_PROPOSE_KEY` for `/api/can_do` and `BLOOM_EXECUTE_KEY` for `/api/execute` (they fall back to
`BLOOM_PROPOSE_KEY` if it has execute scope).

## Polymarket driver (Phase 2 real mode)

Phase 2 enables real Polymarket CLOB placement/cancel while keeping Phase 1 semantics (holds + receipts + UI rollup).
It **does not** include a trading bot yet.

**Required env vars (real mode)**

```bash
export POLY_MODE=real
export POLY_CLOB_HOST=https://clob.polymarket.com
export POLY_GAMMA_HOST=https://gamma-api.polymarket.com
export POLY_DATA_HOST=https://data-api.polymarket.com
export POLY_CHAIN_ID=137
export POLY_PRIVATE_KEY=YOUR_L1_PRIVATE_KEY
```

Optional (cache L2 creds; if absent they are derived via `createOrDeriveApiKey`):
```bash
export POLY_API_KEY=
export POLY_API_SECRET=
export POLY_API_PASSPHRASE=
```

**Worker**

```bash
pnpm worker:polymarket
```

**Manual test (real mode)**

```bash
pnpm dev
pnpm worker:polymarket
pnpm polymarket:dryrun --agent agent_ej --market "test_market" --token "YES_123" --price 0.42 --size 10
pnpm polymarket:cancel --agent agent_ej --order_id ORDER_ID
```

Verify UI state:

```bash
curl -s -H "X-Api-Key: $BLOOM_READ_KEY" "http://localhost:3000/api/ui/state?agent_id=agent_ej"
curl -s -H "X-Api-Key: $BLOOM_READ_KEY" "http://localhost:3000/api/ui/activity?agent_id=agent_ej&limit=10"
```

Security: `POLY_PRIVATE_KEY` is sensitive. Do not log it or commit it.

## Polymarket bot (Phase 2.5 observe-only)

The observe-only bot polls Gamma active markets and emits one receipt per tick. It does **not** trade.

**Env vars**

```bash
export POLY_BOT_AGENT_ID=agent_ej
export POLY_BOT_LOOP_SECONDS=60
export POLY_BOT_TRADING_ENABLED=false
```

**Endpoints**

```bash
curl -s -X POST http://localhost:3000/api/bots/polymarket/start \
  -H 'content-type: application/json' \
  -H "x-admin-key: $BLOOM_ADMIN_KEY" \
  -d '{"agent_id":"agent_ej"}'

curl -s http://localhost:3000/api/bots/polymarket/status \
  -H "x-api-key: $BLOOM_READ_KEY"

curl -s -X POST http://localhost:3000/api/bots/polymarket/stop \
  -H 'content-type: application/json' \
  -H "x-admin-key: $BLOOM_ADMIN_KEY" \
  -d '{}'
```

## API examples

```bash
curl -s -X POST http://localhost:3000/api/agents \
  -H 'content-type: application/json' \
  -d '{"user_id":"user_1","agent_id":"agent_1"}'

curl -s -X POST http://localhost:3000/api/can_do \
  -H 'content-type: application/json' \
  -d '{"user_id":"user_1","agent_id":"agent_1","intent_json":{"type":"request_job"}}'

curl -s -X POST http://localhost:3000/api/auto_execute \
  -H 'content-type: application/json' \
  -d '{"agent_id":"agent_1","intent_json":{"type":"send_usdc","to_address":"0x...","amount_cents":100}}'

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

Optional admin shortcut (dev-only):
```bash
curl -s -X POST http://localhost:3000/api/step_up/approve \
  -H 'content-type: application/json' \
  -H 'x-admin-key: YOUR_ADMIN_API_KEY' \
  -d '{"quote_id":"QUOTE_ID","approve":true}'
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

The MCP server enables Claude Desktop to read agent state and propose actions. Execute tools are **optional** and require a
separate execute-scoped key.

### Available MCP Tools

| Tool | Description | Scope Required |
|------|-------------|----------------|
| `bloom_ui_state` | Fetch user-facing spendable/balance/held | read |
| `bloom_ui_activity` | Fetch user-facing activity rollups | read |
| `bloom_get_state` | Fetch raw state and observation (full audit) | read |
| `bloom_list_receipts` | List raw receipts (full audit) | read |
| `bloom_can_do` | Request a quote (propose only) | propose |
| `bloom_polymarket_place_order` | Place a real Polymarket BUY order | execute |
| `bloom_polymarket_cancel_order` | Cancel a real Polymarket order | execute |
| `bloom_polymarket_reconcile_now` | Run one Polymarket reconciliation cycle | admin |
| `bloom_polymarket_bot_start` | Start the observe-only Polymarket bot | admin |
| `bloom_polymarket_bot_stop` | Stop the observe-only Polymarket bot | admin |
| `bloom_polymarket_bot_status` | Get status for the Polymarket bot | read |

Execute tools are only enabled when `BLOOM_EXECUTE_KEY` is set.

### Step 1: Create Scoped API Keys

The MCP server requires separate keys with minimal scopes:

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

# Optional: create execute-only key (required for real Polymarket place/cancel)
curl -s -X POST http://localhost:3000/api/admin/keys \
  -H 'content-type: application/json' \
  -H 'x-admin-key: YOUR_ADMIN_API_KEY' \
  -d '{"user_id":"mcp_user","scopes":["execute"]}'
```

Save both `api_key` values from the responses.

### Step 2: Configure Claude Desktop

Edit your Claude Desktop config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "bloom": {
      "command": "/path/to/Bloom/scripts/mcp-wrapper.sh",
      "args": [],
      "env": {
        "BLOOM_BASE_URL": "http://localhost:3000",
        "BLOOM_READ_KEY": "your_read_only_api_key",
        "BLOOM_PROPOSE_KEY": "your_propose_only_api_key",
        "BLOOM_EXECUTE_KEY": "your_execute_only_api_key",
        "BLOOM_ADMIN_KEY": "your_admin_key"
      }
    }
  }
}
```

Troubleshooting: If Claude shows `Server disconnected`, restart Claude Desktop after pulling changes and ensure the API
server is running at `BLOOM_BASE_URL`. `BLOOM_EXECUTE_KEY` is required only for real Polymarket place/cancel tools.

Replace `/path/to/Bloom` with your actual repo path. The wrapper forces Node 20 and keeps stdout clean (JSON-RPC only).
If the wrapper is not executable, run: `chmod +x scripts/mcp-wrapper.sh`.

### Step 3: Restart Claude Desktop

Quit and reopen Claude Desktop. The MCP server logs to stderr:
```
Bloom MCP ready | http://localhost:3000
```

### First 3 Prompts to Try

Once configured, ask Claude:

1. **"Show spend summary for agent_ej"**
   - Uses `bloom_ui_state` to fetch human-friendly totals

2. **"Show recent activity for agent_ej"**
   - Uses `bloom_ui_activity` for glance + summary items

3. **"Can agent_ej send $1.00 to 0x1111111111111111111111111111111111111111?"**
   - Uses `bloom_can_do` to check if transfer is allowed
   - Returns a quote with `allowed: true/false`
   - Does NOT execute - human approval required out-of-band

Example Claude phrases (UI-first)
- "What's the spendable number for agent_ej? Use bloom_ui_state."
- "Show agent_ej activity (last 5). Use bloom_ui_activity."
- "Show full audit receipts for agent_ej."

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
 - `BLOOM_EXECUTE_KEY` is only required for execute tools

**"READ_KEY_scope_too_permissive"**
- The read key must have ONLY `["read"]` scope
- Keys with `propose`, `execute`, `owner`, or `*` are rejected
- Create a new key with minimal scope

**"PROPOSE_KEY_scope_too_permissive"**
- The propose key must have ONLY `["propose"]` scope (or `["read", "propose"]`)
- Keys with `execute`, `owner`, or `*` are rejected

**"EXECUTE_KEY_scope_too_permissive"**
- The execute key must have ONLY `["execute"]` scope
- Keys with `propose`, `owner`, or `*` are rejected

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
