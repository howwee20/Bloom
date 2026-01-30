# Bloom Constraint Kernel v0

Provider-agnostic constraint runtime for agents in a persistent environment.

Key rules
- Fail closed by default: if environment freshness is stale/unknown, execution is rejected unless `override_freshness` is explicitly set.
- Irreversible truth: append-only event log with hash chaining.
- Idempotent and auditable: quotes, executions, receipts, and deterministic env state.
- Consequences without suffering: loss of future options, budget, or time (no “pain”).
- Growth definition (v0): improved performance on novel tasks + improved calibration + fewer catastrophes over time, not just higher win-rate on a fixed set.

## Quickstart

```bash
pnpm install
pnpm migrate
pnpm dev
```

## Env vars

- `DB_PATH` (default `./data/kernel.db`)
- `PORT` (default `3000`)
- `ADMIN_API_KEY` (optional; protects `/api/truth_console` via `x-admin-key`)
- `ENV_TYPE` (`simple_economy` | `base_usdc`, default `simple_economy`)
- `ENV_STALE_SECONDS` (default `60`)
- `ENV_UNKNOWN_SECONDS` (default `300`)
- `STEP_UP_SHARED_SECRET` (optional; required when step-up triggers)
- `DEFAULT_CREDITS_CENTS` (default `5000`)
- `DEFAULT_DAILY_SPEND_CENTS` (default `2000`)
- `BASE_RPC_URL` (required when `ENV_TYPE=base_usdc`)
- `BASE_CHAIN` (`base` | `base_sepolia`, default `base_sepolia`)
- `BASE_USDC_CONTRACT` (required when `ENV_TYPE=base_usdc`)
- `CONFIRMATIONS_REQUIRED` (default `5`)
- `USDC_BUFFER_CENTS` (default `0`)
- `DEV_MASTER_MNEMONIC` (required when `ENV_TYPE=base_usdc`; **insecure dev-only**)

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

curl -s -X POST http://localhost:3000/api/execute \
  -H 'content-type: application/json' \
  -H 'x-api-key: YOUR_USER_API_KEY' \
  -d '{"quote_id":"QUOTE_ID","idempotency_key":"IDEMPOTENCY_KEY"}'
```
