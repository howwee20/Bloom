/**
 * Mini-sim for card lifecycle + snapshot loop.
 * Proves: auth → hold → snapshot reserve → settle/release → snapshot clear → receipts
 */
import { createDatabase } from "../src/db/database.js";
import { buildServer } from "../src/api/server.js";
import { SimpleEconomyWorld } from "../src/env/simple_economy.js";
import { agentSpendSnapshot } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { nowSeconds } from "../src/kernel/utils.js";
import type { Config } from "../src/config.js";
import fs from "node:fs";
import path from "node:path";

function applyMigrations(sqlite: import("better-sqlite3").Database) {
  const migrationsDir = path.resolve("src/db/migrations");
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    sqlite.exec(sql);
  }
}

function makeConfig(): Config {
  return {
    API_VERSION: "0.1.0-alpha",
    DB_PATH: ":memory:",
    PORT: 0,
    APPROVAL_UI_PORT: 0,
    BIND_APPROVAL_UI: false,
    ADMIN_API_KEY: "simkey",
    ENV_TYPE: "simple_economy",
    ENV_STALE_SECONDS: 60,
    ENV_UNKNOWN_SECONDS: 300,
    STEP_UP_SHARED_SECRET: null,
    STEP_UP_CHALLENGE_TTL_SECONDS: 120,
    STEP_UP_TOKEN_TTL_SECONDS: 60,
    DEFAULT_CREDITS_CENTS: 50_000,
    DEFAULT_DAILY_SPEND_CENTS: 20_000,
    BASE_RPC_URL: null,
    BASE_CHAIN: "base_sepolia",
    BASE_USDC_CONTRACT: null,
    CONFIRMATIONS_REQUIRED: 5,
    USDC_BUFFER_CENTS: 0,
    DEV_MASTER_MNEMONIC: null
  };
}

async function main() {
  console.log("=== Card Lifecycle Mini-Sim ===\n");

  const { sqlite, db } = createDatabase(":memory:");
  applyMigrations(sqlite);
  const config = makeConfig();
  const env = new SimpleEconomyWorld(db, sqlite, config);
  const { app, kernel } = buildServer({ config, db, sqlite, env });
  await app.ready();

  // 1. Create agent
  const { agent_id, user_id } = kernel.createAgent();
  console.log(`[1] Created agent: ${agent_id}`);

  // Set up initial snapshot with funds
  const now = nowSeconds();
  db.update(agentSpendSnapshot)
    .set({
      confirmedBalanceCents: 100_000,
      reservedOutgoingCents: 0,
      reservedHoldsCents: 0,
      policySpendableCents: 50_000,
      effectiveSpendPowerCents: 50_000,
      updatedAt: now
    })
    .where(eq(agentSpendSnapshot.agentId, agent_id))
    .run();

  // Check initial snapshot
  let snapshot = db.select().from(agentSpendSnapshot).where(eq(agentSpendSnapshot.agentId, agent_id)).get();
  console.log(`[2] Initial snapshot: reservedHoldsCents=${snapshot?.reservedHoldsCents}, effectiveSpendPower=${snapshot?.effectiveSpendPowerCents}`);

  // 2. Create hold A1 via card auth
  const authA1 = await app.inject({
    method: "POST",
    url: "/api/card/auth",
    headers: { "x-admin-key": "simkey" },
    payload: {
      auth_id: "A1",
      card_id: "card_sim",
      agent_id,
      merchant: "Coffee Shop",
      mcc: "5812",
      amount_cents: 15_000,
      currency: "USD",
      timestamp: now
    }
  });
  const a1Json = authA1.json() as { approved: boolean; would_approve: boolean };
  console.log(`[3] Auth A1 (15000c): approved=${a1Json.approved}, would_approve=${a1Json.would_approve}`);

  snapshot = db.select().from(agentSpendSnapshot).where(eq(agentSpendSnapshot.agentId, agent_id)).get();
  console.log(`    Snapshot after A1: reservedHolds=${snapshot?.reservedHoldsCents}, effectiveSpendPower=${snapshot?.effectiveSpendPowerCents}`);

  // 3. Create hold A2
  const authA2 = await app.inject({
    method: "POST",
    url: "/api/card/auth",
    headers: { "x-admin-key": "simkey" },
    payload: {
      auth_id: "A2",
      card_id: "card_sim",
      agent_id,
      merchant: "Restaurant",
      mcc: "5812",
      amount_cents: 20_000,
      currency: "USD",
      timestamp: now
    }
  });
  const a2Json = authA2.json() as { approved: boolean; would_approve: boolean };
  console.log(`[4] Auth A2 (20000c): approved=${a2Json.approved}, would_approve=${a2Json.would_approve}`);

  snapshot = db.select().from(agentSpendSnapshot).where(eq(agentSpendSnapshot.agentId, agent_id)).get();
  console.log(`    Snapshot after A2: reservedHolds=${snapshot?.reservedHoldsCents}, effectiveSpendPower=${snapshot?.effectiveSpendPowerCents}`);

  // 4. Settle A1
  const settleA1 = await app.inject({
    method: "POST",
    url: "/api/card/settle",
    headers: { "x-admin-key": "simkey" },
    payload: {
      agent_id,
      auth_id: "A1",
      settled_amount_cents: 14_500,
      settled_at: now
    }
  });
  console.log(`[5] Settle A1: status=${settleA1.statusCode}`);

  snapshot = db.select().from(agentSpendSnapshot).where(eq(agentSpendSnapshot.agentId, agent_id)).get();
  console.log(`    Snapshot after settle A1: reservedHolds=${snapshot?.reservedHoldsCents}, effectiveSpendPower=${snapshot?.effectiveSpendPowerCents}`);

  // 5. Release A2
  const releaseA2 = await app.inject({
    method: "POST",
    url: "/api/card/release",
    headers: { "x-admin-key": "simkey" },
    payload: {
      agent_id,
      auth_id: "A2",
      reason: "voided",
      released_at: now
    }
  });
  console.log(`[6] Release A2: status=${releaseA2.statusCode}`);

  snapshot = db.select().from(agentSpendSnapshot).where(eq(agentSpendSnapshot.agentId, agent_id)).get();
  console.log(`    Snapshot after release A2: reservedHolds=${snapshot?.reservedHoldsCents}, effectiveSpendPower=${snapshot?.effectiveSpendPowerCents}`);

  // 6. Get summary
  // Need API key for user endpoints - create one
  const keyRes = await app.inject({
    method: "POST",
    url: "/api/admin/keys",
    headers: { "x-admin-key": "simkey" },
    payload: { user_id }
  });
  const apiKey = (keyRes.json() as { api_key: string }).api_key;

  const summaryRes = await app.inject({
    method: "GET",
    url: `/api/agents/${agent_id}/summary?window=1d`,
    headers: { "x-api-key": apiKey }
  });
  const summary = summaryRes.json();
  console.log(`\n[7] Summary:\n${JSON.stringify(summary, null, 2)}`);

  // 7. Get timeline
  const timelineRes = await app.inject({
    method: "GET",
    url: `/api/agents/${agent_id}/timeline?since=0&limit=20`,
    headers: { "x-api-key": apiKey }
  });
  const timelineData = timelineRes.json() as { timeline: Array<{ id: string; kind: string; type?: string; what_happened?: string; why_changed?: string }> };
  const timeline = timelineData.timeline ?? [];
  console.log(`\n[8] Timeline (${timeline.length} items):`);
  for (const r of timeline.slice(0, 10)) {
    const desc = r.what_happened ?? r.why_changed ?? r.type ?? "?";
    console.log(`    - [${r.kind}] ${desc.slice(0, 70)}...`);
  }

  // 8. Verify determinism: try to settle already-settled hold
  const settleAgain = await app.inject({
    method: "POST",
    url: "/api/card/settle",
    headers: { "x-admin-key": "simkey" },
    payload: {
      agent_id,
      auth_id: "A1",
      settled_amount_cents: 14_500,
      settled_at: now
    }
  });
  console.log(`\n[9] Double-settle A1: status=${settleAgain.statusCode}, body=${JSON.stringify(settleAgain.json())}`);

  // 9. Final snapshot check
  snapshot = db.select().from(agentSpendSnapshot).where(eq(agentSpendSnapshot.agentId, agent_id)).get();
  console.log(`\n[10] Final snapshot:`);
  console.log(`    confirmedBalanceCents: ${snapshot?.confirmedBalanceCents}`);
  console.log(`    reservedOutgoingCents: ${snapshot?.reservedOutgoingCents}`);
  console.log(`    reservedHoldsCents: ${snapshot?.reservedHoldsCents}`);
  console.log(`    policySpendableCents: ${snapshot?.policySpendableCents}`);
  console.log(`    effectiveSpendPowerCents: ${snapshot?.effectiveSpendPowerCents}`);

  // Verify pass conditions
  // Note: double-settle returns 200 with idempotent:true (correct behavior for settled holds)
  const receiptsInTimeline = timeline.filter((t) => t.kind === "receipt");
  const hasShadowAuth = receiptsInTimeline.some((r) => r.why_changed === "shadow_would_approve" || r.why_changed === "shadow_would_decline");
  const hasSettled = receiptsInTimeline.some((r) => r.why_changed === "card_settled");
  const hasReleased = receiptsInTimeline.some((r) => r.why_changed === "card_released");
  const reservesCleared = snapshot?.reservedHoldsCents === 0;
  const settleIdempotent = settleAgain.statusCode === 200 || settleAgain.statusCode === 409;

  console.log(`\n[11] Pass conditions:`);
  console.log(`    reservesCleared: ${reservesCleared}`);
  console.log(`    hasShadowAuth: ${hasShadowAuth}`);
  console.log(`    hasSettled: ${hasSettled}`);
  console.log(`    hasReleased: ${hasReleased}`);
  console.log(`    settleIdempotent: ${settleIdempotent}`);

  const passed = reservesCleared && hasShadowAuth && hasSettled && hasReleased && settleIdempotent;

  console.log(`\n=== RESULT: ${passed ? "PASS" : "FAIL"} ===`);

  await app.close();
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
