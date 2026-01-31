/**
 * Benchmark script for card auth shadow handler.
 * Measures p50/p95/p99 latency for N=1000 operations.
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
  sqlite.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
}

function makeConfig(): Config {
  return {
    API_VERSION: "0.1.0-alpha",
    DB_PATH: ":memory:",
    PORT: 0,
    APPROVAL_UI_PORT: 0,
    BIND_APPROVAL_UI: false,
    ADMIN_API_KEY: "benchkey",
    ENV_TYPE: "simple_economy",
    ENV_STALE_SECONDS: 60,
    ENV_UNKNOWN_SECONDS: 300,
    STEP_UP_SHARED_SECRET: null,
    STEP_UP_CHALLENGE_TTL_SECONDS: 120,
    STEP_UP_TOKEN_TTL_SECONDS: 60,
    DEFAULT_CREDITS_CENTS: 100_000,
    DEFAULT_DAILY_SPEND_CENTS: 50_000,
    BASE_RPC_URL: null,
    BASE_CHAIN: "base_sepolia",
    BASE_USDC_CONTRACT: null,
    CONFIRMATIONS_REQUIRED: 5,
    USDC_BUFFER_CENTS: 0,
    DEV_MASTER_MNEMONIC: null
  };
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

async function main() {
  const N = 1000;
  const { sqlite, db } = createDatabase(":memory:");
  applyMigrations(sqlite);
  const config = makeConfig();
  const env = new SimpleEconomyWorld(db, sqlite, config);
  const { app, kernel } = buildServer({ config, db, sqlite, env });
  await app.ready();

  const { agent_id } = kernel.createAgent();
  const now = nowSeconds();

  // Set up a large enough snapshot to avoid declines
  db.update(agentSpendSnapshot)
    .set({
      confirmedBalanceCents: 10_000_000,
      reservedOutgoingCents: 0,
      reservedHoldsCents: 0,
      policySpendableCents: 10_000_000,
      effectiveSpendPowerCents: 10_000_000,
      updatedAt: now
    })
    .where(eq(agentSpendSnapshot.agentId, agent_id))
    .run();

  const latencies: number[] = [];

  for (let i = 0; i < N; i++) {
    const start = performance.now();
    await app.inject({
      method: "POST",
      url: "/api/card/auth",
      headers: { "x-admin-key": "benchkey" },
      payload: {
        auth_id: `auth_bench_${i}`,
        card_id: "card_bench",
        agent_id,
        merchant: "Benchmark",
        mcc: "5812",
        amount_cents: 100,
        currency: "USD",
        timestamp: now
      }
    });
    const end = performance.now();
    latencies.push(end - start);
  }

  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

  console.log(`\n=== Card Auth Latency Benchmark (N=${N}) ===`);
  console.log(`Average: ${avg.toFixed(2)}ms`);
  console.log(`p50:     ${p50.toFixed(2)}ms`);
  console.log(`p95:     ${p95.toFixed(2)}ms`);
  console.log(`p99:     ${p99.toFixed(2)}ms`);
  console.log(`Min:     ${Math.min(...latencies).toFixed(2)}ms`);
  console.log(`Max:     ${Math.max(...latencies).toFixed(2)}ms`);

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
