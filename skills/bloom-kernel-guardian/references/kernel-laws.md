# Bloom Kernel Laws (contract)

P1: Receipts are append-only (no UPDATE/DELETE; tamper-evident).
P1: No kernel state mutation without an event+receipt (no ghost state).
P1: Events are hash-chained and append-only.
P2: Fail-closed semantics must match the contract text (freshness gating behavior documented).
P2: Idempotency: quotes unique per (agent_id, idempotency_key); executions unique per quote_id.
