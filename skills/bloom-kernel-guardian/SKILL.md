---
name: bloom-kernel-guardian
description: Enforce Bloom Kernel protocol laws on all changes to kernel code, migrations, events, receipts, policies, budgets, step-up, and card endpoints. Use to (1) prevent mutable receipts, (2) prevent state mutations without events/receipts, (3) keep fail-closed freshness behavior consistent with the written contract, and (4) require tests for critical flows (step-up, base USDC transfer, card holds).
---

# Bloom Kernel Guardian

## Non-negotiable kernel laws
- Receipts are append-only (DB-level immutability; UPDATE/DELETE blocked).
- All kernel state changes must be causally logged (event + receipt), or derived from the log.
- Contract text (README/spec) must match behavior (freshness gating, quoting/execution rules).
- The syscall surface stays small: can_do -> quote -> approve/step-up -> execute -> receipt.
- Add/modify tests whenever a law is touched.

## Workflow (always follow)
1) Identify touched files (kernel.ts, events.ts, receipts.ts, migrations/*.sql, server.ts, env adapters).
2) Run guardian checks:
   - schema immutability checks (events + receipts)
   - grep scan for ghost-state mutations
   - run unit tests + minimal e2e smoke
3) If a law is violated:
   - propose the minimal fix
   - add a test that fails before the fix and passes after
4) Update contract docs if behavior is intentional.

## How to run checks
Run:
- python skills/bloom-kernel-guardian/scripts/guardian.py
- pnpm test (or your test runner)
