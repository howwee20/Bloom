# Phase 4: Real-Money Polymarket Trading Runbook

This document describes how to safely enable real-money automated Polymarket trading with Bloom.

## Overview

Phase 4 implements a trading gate with strict safety controls:
- Kill switch endpoint
- Per-order, daily, and open holds limits
- Step-up requirement for trades (unless auto-approved)
- Reconciliation worker for order state maintenance

## Safety Limits

### Recommended Tiny Defaults (for testing)

```bash
# .env
POLY_MAX_PER_ORDER_CENTS=10    # Max 10 cents per order
POLY_MAX_PER_DAY_CENTS=50      # Max 50 cents per day (0=disabled)
POLY_MAX_OPEN_HOLDS_CENTS=20   # Max 20 cents in open holds
POLY_MAX_OPEN_ORDERS=5         # Max 5 open orders
```

### Production Defaults

```bash
POLY_MAX_PER_ORDER_CENTS=100
POLY_MAX_PER_DAY_CENTS=500
POLY_MAX_OPEN_HOLDS_CENTS=200
POLY_MAX_OPEN_ORDERS=10
```

## Configuration

### Enable Real Trading Mode

```bash
# .env
POLY_MODE=real
POLY_PRIVATE_KEY=your_private_key_here  # NEVER commit this
POLY_API_KEY=your_api_key
POLY_API_SECRET=your_api_secret
POLY_API_PASSPHRASE=your_passphrase
POLY_CHAIN_ID=137  # Polygon mainnet
```

### Enable Bot Trading

```bash
# Bot trading is DISABLED by default
POLY_BOT_TRADING_ENABLED=false

# When enabled, the bot will evaluate trades but require step-up
# unless auto-approve is also enabled
POLY_BOT_TRADING_ENABLED=true
```

### Auto-Approve Configuration

By default, all trades require step-up approval. To enable auto-approval:

```bash
# Enable auto-approve for specific agents
POLY_TRADE_AUTO_APPROVE=true
BLOOM_AUTO_APPROVE_AGENT_IDS=agent_ej

# Define trade parameters (bot uses these when trading enabled)
POLY_TRADE_TOKEN_ID=your_token_id
POLY_TRADE_PRICE=0.50
POLY_TRADE_SIZE=1
POLY_TRADE_MARKET_SLUG=market-slug
POLY_MIN_SECONDS_BETWEEN_TRADES=3600  # 1 hour cooldown
```

### Agent Allowlist

Agents must be explicitly allowlisted for Polymarket trading:

```bash
BLOOM_ALLOW_POLYMARKET=true
BLOOM_ALLOW_POLYMARKET_AGENT_IDS=agent_ej,agent_other
```

## Running the System

### 1. Start the API Server

```bash
pnpm dev
```

### 2. Start the Reconciliation Worker (Required)

The reconciliation worker maintains order state truth:

```bash
pnpm worker:polymarket
```

This worker:
- Syncs order statuses with Polymarket CLOB
- Releases holds for filled/cancelled orders
- Emits receipts for state changes

**Important:** Never run real trades without the reconcile worker running.

### 3. Start the Bot (Optional)

```bash
# Via API
curl -X POST http://localhost:3000/api/bots/polymarket/start \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_API_KEY" \
  -d '{"agent_id":"agent_ej"}'

# Via MCP
bloom_polymarket_bot_start
```

### 4. Check Bot Status

```bash
curl http://localhost:3000/api/bots/polymarket/status \
  -H "X-Api-Key: $BLOOM_READ_KEY"
```

Response:
```json
{
  "running": true,
  "killed": false,
  "agent_id": "agent_ej",
  "loop_seconds": 60,
  "last_tick_at": 1234567890,
  "next_tick_at": 1234567950,
  "last_trade_at": null,
  "trading_enabled": false
}
```

## Kill Switch

The kill switch is your emergency stop button.

### Activate Kill Switch

```bash
# Stop bot only
curl -X POST http://localhost:3000/api/bots/polymarket/kill \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_API_KEY"

# Stop bot AND cancel all open orders
curl -X POST http://localhost:3000/api/bots/polymarket/kill \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_API_KEY" \
  -d '{"cancel_orders":true}'
```

Response:
```json
{
  "killed": true,
  "stopped": true,
  "orders_cancelled": 3,
  "receipt_id": "rec_abc123"
}
```

### Via MCP

```
bloom_polymarket_bot_kill (cancel_orders=true)
```

### After Kill Switch

- Bot is stopped and marked as "killed"
- Trading is effectively disabled until manual restart
- Open orders are optionally cancelled
- A receipt is created documenting the kill

To restart after kill:
```bash
curl -X POST http://localhost:3000/api/bots/polymarket/start \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_API_KEY" \
  -d '{"agent_id":"agent_ej"}'
```

## Daily Limit Enforcement

Daily limits reset at UTC midnight.

### How It Works

1. Each trade creates a hold with `source='polymarket'`
2. `getPolymarketSpendTodayCents()` sums pending+settled holds since UTC midnight
3. New trades are denied if `spend_today + trade_cost > POLY_MAX_PER_DAY_CENTS`
4. Reason code: `"daily_limit_reached"`

### Checking Daily Spend

The bot tick receipts include daily spend information when trading is enabled:

```json
{
  "trade_decision": "daily_limit",
  "trade_details": {
    "spend_today_cents": 45,
    "trade_cost_cents": 10,
    "max_daily_cents": 50
  }
}
```

## Step-Up Flow

When `POLY_BOT_TRADING_ENABLED=true` and `POLY_TRADE_AUTO_APPROVE=false`:

1. `canDo` returns `{ allowed: true, requires_step_up: true }`
2. Human must approve via step-up challenge
3. After approval, `execute` places the order

When `POLY_TRADE_AUTO_APPROVE=true` AND agent is in `BLOOM_AUTO_APPROVE_AGENT_IDS`:
- Step-up is bypassed
- Orders execute automatically (within limits)

## Monitoring

### Bot Tick Receipts

Each bot tick creates a receipt with:
- `trade_decision`: `observe_only`, `would_trade`, `daily_limit`, `cooldown`, etc.
- `trade_details`: Context about the decision
- `markets_scanned`: Number of markets scanned
- `top_markets`: Top 3 markets by volume

### Order Lifecycle

Track orders through receipts:
1. `polymarket_order_posted` - Order submitted to CLOB
2. `polymarket_hold_created` - Capital reserved
3. `polymarket_order_filled` - Order filled (via reconcile)
4. `polymarket_hold_released` - Capital released

### Truth Console

For debugging, use the truth console:

```bash
curl "http://localhost:3000/api/truth_console?agent_id=agent_ej" \
  -H "X-Admin-Key: $ADMIN_API_KEY"
```

## Troubleshooting

### "polymarket_real_disabled"
- Check `POLY_MODE=real` in .env

### "polymarket_private_key_missing"
- Ensure `POLY_PRIVATE_KEY` is set

### "intent_not_allowlisted"
- Add agent to `BLOOM_ALLOW_POLYMARKET_AGENT_IDS`
- Ensure `BLOOM_ALLOW_POLYMARKET=true`

### "daily_limit_reached"
- Daily limit has been hit
- Wait until UTC midnight for reset
- Or increase `POLY_MAX_PER_DAY_CENTS`

### "order_cost_exceeds_max"
- Trade cost exceeds `POLY_MAX_PER_ORDER_CENTS`
- Reduce trade size or increase limit

### Bot not placing trades
1. Check `POLY_BOT_TRADING_ENABLED=true`
2. Check trade config is set (TOKEN_ID, PRICE, SIZE)
3. Check cooldown hasn't expired
4. Check daily/order/hold limits

## Security Checklist

- [ ] Private key is in .env (not committed)
- [ ] .env is in .gitignore
- [ ] Reconcile worker is running
- [ ] Limits are set appropriately low
- [ ] Agent allowlist is minimal
- [ ] Admin key is strong and not shared
- [ ] Kill switch endpoint is tested
- [ ] Step-up is required for high-value trades
