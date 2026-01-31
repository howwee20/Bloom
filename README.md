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

Not in contract
- Client SDKs, CLI tooling, or example apps.
- The approval UI or any other web UI.
- Provider-specific payload shapes (e.g., Base USDC receipts or card metadata beyond declared fields).
- Internal DB schemas, migrations, or log formatting.

## Quickstart

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

## MCP server (read/propose only)

Run the MCP server locally:
```bash
export BLOOM_BASE_URL=http://localhost:3000
export BLOOM_READ_KEY=READ_API_KEY
export BLOOM_PROPOSE_KEY=PROPOSE_API_KEY
pnpm mcp
```
The MCP server fails closed if either key includes execute/owner scopes or is missing its required scope.

Create scoped keys with the admin endpoint:
```bash
curl -s -X POST http://localhost:3000/api/admin/keys \
  -H 'content-type: application/json' \
  -H 'x-admin-key: YOUR_ADMIN_API_KEY' \
  -d '{"user_id":"user_1","scopes":["read"]}'
```

Claude Desktop config snippet:
```json
{
  "mcpServers": {
    "bloom": {
      "command": "pnpm",
      "args": ["mcp"],
      "env": {
        "BLOOM_BASE_URL": "http://localhost:3000",
        "BLOOM_READ_KEY": "READ_API_KEY",
        "BLOOM_PROPOSE_KEY": "PROPOSE_API_KEY"
      }
    }
  }
}
```

Smoke test:
```bash
export BLOOM_AGENT_ID=AGENT_ID
pnpm mcp:smoke
```

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
