import fs from "node:fs";
import path from "node:path";
import { createDatabase } from "../src/db/database.js";
import { SimpleEconomyWorld } from "../src/env/simple_economy.js";
import { Kernel } from "../src/kernel/kernel.js";
import { PolymarketDryrunDriver } from "../src/drivers/polymarket_dryrun_driver.js";
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
    BLOOM_ALLOW_TRANSFER: overrides.BLOOM_ALLOW_TRANSFER ?? false,
    BLOOM_ALLOW_TRANSFER_AGENT_IDS: overrides.BLOOM_ALLOW_TRANSFER_AGENT_IDS ?? [],
    BLOOM_ALLOW_TRANSFER_TO: overrides.BLOOM_ALLOW_TRANSFER_TO ?? [],
    BLOOM_AUTO_APPROVE_TRANSFER_MAX_CENTS: overrides.BLOOM_AUTO_APPROVE_TRANSFER_MAX_CENTS ?? null,
    BLOOM_AUTO_APPROVE_AGENT_IDS: overrides.BLOOM_AUTO_APPROVE_AGENT_IDS ?? [],
    BLOOM_AUTO_APPROVE_TO: overrides.BLOOM_AUTO_APPROVE_TO ?? [],
    BLOOM_ALLOW_POLYMARKET: overrides.BLOOM_ALLOW_POLYMARKET ?? false,
    BLOOM_ALLOW_POLYMARKET_AGENT_IDS: overrides.BLOOM_ALLOW_POLYMARKET_AGENT_IDS ?? [],
    POLY_DRYRUN_MAX_PER_ORDER_CENTS: overrides.POLY_DRYRUN_MAX_PER_ORDER_CENTS ?? 500,
    POLY_DRYRUN_MAX_OPEN_HOLDS_CENTS: overrides.POLY_DRYRUN_MAX_OPEN_HOLDS_CENTS ?? 2000,
    POLY_DRYRUN_MAX_OPEN_ORDERS: overrides.POLY_DRYRUN_MAX_OPEN_ORDERS ?? 20,
    POLY_DRYRUN_LOOP_SECONDS: overrides.POLY_DRYRUN_LOOP_SECONDS ?? 30,
    POLY_MODE: overrides.POLY_MODE ?? "dryrun",
    POLY_CLOB_HOST: overrides.POLY_CLOB_HOST ?? "https://clob.polymarket.com",
    POLY_GAMMA_HOST: overrides.POLY_GAMMA_HOST ?? "https://gamma-api.polymarket.com",
    POLY_DATA_HOST: overrides.POLY_DATA_HOST ?? "https://data-api.polymarket.com",
    POLY_CHAIN_ID: overrides.POLY_CHAIN_ID ?? 137,
    POLY_PRIVATE_KEY: overrides.POLY_PRIVATE_KEY ?? null,
    POLY_API_KEY: overrides.POLY_API_KEY ?? null,
    POLY_API_SECRET: overrides.POLY_API_SECRET ?? null,
    POLY_API_PASSPHRASE: overrides.POLY_API_PASSPHRASE ?? null,
    POLY_BOT_AGENT_ID: "agent_ej",
    POLY_BOT_LOOP_SECONDS: 60,
    POLY_BOT_TRADING_ENABLED: false,
  };
  const env = new SimpleEconomyWorld(db, sqlite, config);
  const kernel = new Kernel(db, sqlite, env, config, [new PolymarketDryrunDriver()]);
  return { sqlite, db, env, kernel, config };
}
