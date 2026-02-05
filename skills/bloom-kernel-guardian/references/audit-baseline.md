# Audit baseline (must be fixed)

P1) receipts table is mutable (UPDATE/DELETE allowed) -> breaks auditability
P1) createAgent and ensureDailyReset mutate state without event/receipt -> breaks causal log + replay
P2) freshness gating blocks can_do (quote) as well as execute -> must match README/spec
