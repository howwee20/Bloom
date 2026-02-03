# Polymarket Real Order Loop - Proof of Concept

**Date:** 2026-02-02
**Status:** VERIFIED
**Significance:** First real-money Polymarket order lifecycle through Bloom constraint kernel

---

## Summary

Successfully executed a complete **place → hold → cancel → release** cycle on Polymarket mainnet through the Bloom constraint kernel. This proves:

1. Real mode integration works end-to-end
2. Kernel physics (hold/release) function correctly
3. Idempotent lifecycle management works
4. UI reflects true wallet state

---

## Test Parameters

| Parameter | Value |
|-----------|-------|
| Market | `will-trump-deport-less-than-250000` |
| Token ID | `101676997363687199724245607342877036148401850938023978421879460310389391082353` |
| Price | $0.02 |
| Size | 5 shares |
| Total Cost | $0.10 |
| Agent | `agent_ej` |

---

## Phase 1: Place Order

### QUOTE Response
```json
{
  "quote_id": "quote_b921854c-f7fa-4f6a-9717-6510bc49c83a",
  "allowed": true,
  "requires_step_up": false,
  "reason": "ok",
  "expires_at": 1770090858,
  "idempotency_key": "idem_7720443b-4e73-4f27-9d2c-29c5772fc08c"
}
```

### EXEC Response
```json
{
  "status": "applied",
  "exec_id": "exec_9476e146-3edd-48e8-a690-174532f87152",
  "external_ref": "poly_order_bd6806a9-e4fc-498e-8c19-e250ffa207ad"
}
```

### UI State After Place
```json
{
  "agent_id": "agent_ej",
  "balance": "$8.00 balance",
  "held": "$0.10 held",
  "net_worth": "$8.00"
}
```

---

## Phase 2: Cancel Order

### QUOTE Response
```json
{
  "quote_id": "quote_b1ba0de6-fa43-464e-bfdb-be69d0f9c988",
  "allowed": true,
  "requires_step_up": false,
  "reason": "ok",
  "expires_at": 1770090870,
  "idempotency_key": "idem_325da6de-41ee-443d-aae9-5b09939da2a6"
}
```

### EXEC Response
```json
{
  "status": "applied",
  "exec_id": "exec_aae49b0c-9f6d-4a1f-a2be-b3ea3b435b50",
  "external_ref": "poly_order_bd6806a9-e4fc-498e-8c19-e250ffa207ad"
}
```

### UI State After Cancel
```json
{
  "agent_id": "agent_ej",
  "number": "$8.00",
  "balance": "$8.00 balance",
  "held": "$0.00 held",
  "net_worth": "$8.00",
  "updated": "just now",
  "details": {
    "spendable_cents": 800,
    "balance_cents": 800,
    "held_cents": 0
  }
}
```

---

## Phase 3: UI Activity Log

```json
[
  {
    "id": "quote_b1ba0de6-fa43-464e-bfdb-be69d0f9c988",
    "line": "Canceled $0.10 · Released",
    "status": "confirmed",
    "when": "Today 10:49 PM",
    "summary": [
      "Approved · 10:49 PM",
      "Released $0.10 · 10:49 PM",
      "Canceled · 10:49 PM",
      "Pending · 10:49 PM"
    ]
  },
  {
    "id": "quote_b921854c-f7fa-4f6a-9717-6510bc49c83a",
    "line": "Held $0.10 · Pending",
    "status": "pending",
    "when": "Today 10:49 PM",
    "summary": [
      "Approved · 10:49 PM",
      "Held $0.10 · 10:49 PM",
      "Pending · 10:49 PM"
    ]
  }
]
```

---

## Verification Checklist

- [x] QUOTE returns `allowed: true`
- [x] EXEC returns `status: applied`
- [x] External reference generated (`poly_order_*`)
- [x] Hold applied on place ($0.10)
- [x] Cancel succeeds with same external_ref
- [x] Hold released after cancel ($0.00)
- [x] UI activity shows complete lifecycle
- [x] Balance unchanged (no fills, clean cancel)

---

## Architecture Validated

```
Intent → Kernel (quote/exec) → Driver (Polymarket API) → Receipt → UI
   ↓           ↓                      ↓                    ↓
 Policy    Hold/Release           Real Order           Truth Display
```

---

## What This Proves

1. **Kernel as Law**: The constraint kernel correctly gates real-money actions
2. **Hold Semantics**: Funds are reserved during order lifecycle
3. **Release Semantics**: Funds return immediately on cancel
4. **Idempotency**: Same external_ref used for place and cancel
5. **UI Truth**: Dashboard reflects actual wallet state

---

---

## Addendum: Second Order Test (Left Open)

### Order Placed
```json
{
  "quote_id": "quote_144be53f-e15a-4e97-927d-ced3d5a589a0",
  "allowed": true
}
{
  "status": "applied",
  "external_ref": "poly_order_eca3e020-e9a7-4dfe-812a-687ff9237650"
}
```

### UI State While Open
```json
{
  "balance": "$8.00 balance",
  "held": "$0.05 held",
  "spendable_cents": 795
}
```

### Database State While Open
```
poly_order_eca3e020... | status: open | size: 5 | cost: $0.05
```

### After Cancel
```json
{
  "balance": "$8.00 balance",
  "held": "$0.00 held",
  "spendable_cents": 800
}
```

```
poly_order_eca3e020... | status: canceled
poly_order_bd6806a9... | status: canceled
poly_order_83268316... | status: canceled
```

---

## Next Steps

1. [x] Test order left open ← DONE
2. [ ] Test partial/full fill scenarios (requires market activity)
3. [ ] Add real-mode guardrails (max spend, rate limits)
4. [ ] Run observe-only bot for stability validation
5. [ ] Phase 4: Trading enabled with EV engine

---

*This is Bloom's "Stripe $1 charge" moment for Polymarket.*
