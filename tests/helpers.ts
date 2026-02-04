import fs from "node:fs";
import path from "node:path";
import { createDatabase } from "../src/db/database.js";
import { SimpleEconomyWorld } from "../src/env/simple_economy.js";
import { Kernel } from "../src/kernel/kernel.js";
import type { Config } from "../src/config.js";

export function applyMigrations(sqlite: import("better-sqlite3").Database) {
  const migrationsDir = path.resolve("src/db/migrations");
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    sqlite.exec(sql);
  }
  sqlite.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
}

export function createTestContext(overrides: Partial<Config> = {}) {
  const { sqlite, db } = createDatabase(":memory:");
  applyMigrations(sqlite);
  const config: Config = {
    API_VERSION: overrides.API_VERSION ?? "0.1.0-alpha",
    DB_PATH: ":memory:",
    CONSOLE_DB_PATH: ":memory:",
    PORT: 0,
    APPROVAL_UI_PORT: 0,
    BIND_APPROVAL_UI: false,
    CARD_MODE: overrides.CARD_MODE ?? "dev",
    CARD_WEBHOOK_SHARED_SECRET: overrides.CARD_WEBHOOK_SHARED_SECRET ?? null,
    ADMIN_API_KEY: null,
    ENV_TYPE: overrides.ENV_TYPE ?? "simple_economy",
    ENV_STALE_SECONDS: overrides.ENV_STALE_SECONDS ?? 1,
    ENV_UNKNOWN_SECONDS: overrides.ENV_UNKNOWN_SECONDS ?? 2,
    STEP_UP_SHARED_SECRET: overrides.STEP_UP_SHARED_SECRET ?? "stepup",
    STEP_UP_CHALLENGE_TTL_SECONDS: overrides.STEP_UP_CHALLENGE_TTL_SECONDS ?? 120,
    STEP_UP_TOKEN_TTL_SECONDS: overrides.STEP_UP_TOKEN_TTL_SECONDS ?? 60,
    DEFAULT_CREDITS_CENTS: overrides.DEFAULT_CREDITS_CENTS ?? 500,
    DEFAULT_DAILY_SPEND_CENTS: overrides.DEFAULT_DAILY_SPEND_CENTS ?? 200,
    BASE_RPC_URL: overrides.BASE_RPC_URL ?? null,
    BASE_CHAIN: overrides.BASE_CHAIN ?? "base_sepolia",
    BASE_USDC_CONTRACT: overrides.BASE_USDC_CONTRACT ?? null,
    CONFIRMATIONS_REQUIRED: overrides.CONFIRMATIONS_REQUIRED ?? 5,
    USDC_BUFFER_CENTS: overrides.USDC_BUFFER_CENTS ?? 0,
    DEV_MASTER_MNEMONIC: overrides.DEV_MASTER_MNEMONIC ?? null,
    LITHIC_API_KEY: overrides.LITHIC_API_KEY ?? null,
    LITHIC_ASA_SECRET: overrides.LITHIC_ASA_SECRET ?? null,
    LITHIC_API_URL: overrides.LITHIC_API_URL ?? "https://sandbox.lithic.com"
  };
  const env = new SimpleEconomyWorld(db, sqlite, config);
  const kernel = new Kernel(db, sqlite, env, config);
  return { sqlite, db, env, kernel, config };
}
