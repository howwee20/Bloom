import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db/database.js";
import { applyMigrations } from "./helpers.js";
import { buildServer } from "../src/api/server.js";
import { SimpleEconomyWorld } from "../src/env/simple_economy.js";
import type { Config } from "../src/config.js";
import { computeCardSignature } from "../src/api/card_webhook.js";
import { nowSeconds } from "../src/kernel/utils.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    API_VERSION: "0.1.0-alpha",
    DB_PATH: ":memory:",
    PORT: 0,
    APPROVAL_UI_PORT: 0,
    BIND_APPROVAL_UI: false,
    CARD_MODE: "dev",
    CARD_WEBHOOK_SHARED_SECRET: null,
    ADMIN_API_KEY: "adminkey",
    ENV_TYPE: "simple_economy",
    ENV_STALE_SECONDS: 60,
    ENV_UNKNOWN_SECONDS: 300,
    STEP_UP_SHARED_SECRET: null,
    STEP_UP_CHALLENGE_TTL_SECONDS: 120,
    STEP_UP_TOKEN_TTL_SECONDS: 60,
    DEFAULT_CREDITS_CENTS: 5000,
    DEFAULT_DAILY_SPEND_CENTS: 2000,
    BASE_RPC_URL: null,
    BASE_CHAIN: "base_sepolia",
    BASE_USDC_CONTRACT: null,
    CONFIRMATIONS_REQUIRED: 5,
    USDC_BUFFER_CENTS: 0,
    DEV_MASTER_MNEMONIC: null,
    BLOOM_ALLOW_TRANSFER: false,
    BLOOM_ALLOW_TRANSFER_AGENT_IDS: [],
    BLOOM_ALLOW_TRANSFER_TO: [],
    BLOOM_AUTO_APPROVE_TRANSFER_MAX_CENTS: null,
    BLOOM_AUTO_APPROVE_AGENT_IDS: [],
    BLOOM_AUTO_APPROVE_TO: [],
    BLOOM_ALLOW_POLYMARKET: false,
    BLOOM_ALLOW_POLYMARKET_AGENT_IDS: [],
    POLY_DRYRUN_MAX_PER_ORDER_CENTS: 500,
    POLY_DRYRUN_MAX_OPEN_HOLDS_CENTS: 2000,
    POLY_DRYRUN_MAX_OPEN_ORDERS: 20,
    POLY_DRYRUN_LOOP_SECONDS: 30,
    POLY_MODE: "dryrun",
    POLY_CLOB_HOST: "https://clob.polymarket.com",
    POLY_GAMMA_HOST: "https://gamma-api.polymarket.com",
    POLY_DATA_HOST: "https://data-api.polymarket.com",
    POLY_CHAIN_ID: 137,
    POLY_PRIVATE_KEY: null,
    POLY_API_KEY: null,
    POLY_API_SECRET: null,
    POLY_API_PASSPHRASE: null,
    POLY_BOT_AGENT_ID: "agent_ej",
    POLY_BOT_LOOP_SECONDS: 60,
    POLY_BOT_TRADING_ENABLED: false,
    ...overrides
  };
}

async function createApp(overrides: Partial<Config> = {}) {
  const { sqlite, db } = createDatabase(":memory:");
  applyMigrations(sqlite);
  const config = makeConfig(overrides);
  const env = new SimpleEconomyWorld(db, sqlite, config);
  const { app, kernel } = buildServer({ config, db, sqlite, env });
  await app.ready();
  return { app, kernel };
}

function buildPayload() {
  return {
    auth_id: "auth_webhook",
    card_id: "card_1",
    agent_id: "agent_1",
    merchant: "Test",
    mcc: "5812",
    amount_cents: 1000,
    currency: "USD",
    timestamp: nowSeconds()
  };
}

describe("Card webhook verification", () => {
  it("dev mode accepts unsigned", async () => {
    const { app, kernel } = await createApp({ CARD_MODE: "dev" });
    kernel.createAgent({ agentId: "agent_1" });
    const basePayload = buildPayload();

    const res = await app.inject({
      method: "POST",
      url: "/api/card/auth",
      payload: basePayload
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { approved: boolean; auth_status?: string };
    expect(json.approved).toBe(true);
    expect(json.auth_status).toBe("dev_unsigned");

    await app.close();
  });

  it("shadow mode rejects unsigned", async () => {
    const { app, kernel } = await createApp({
      CARD_MODE: "shadow",
      CARD_WEBHOOK_SHARED_SECRET: "secret"
    });
    kernel.createAgent({ agentId: "agent_1" });
    const basePayload = buildPayload();

    const res = await app.inject({
      method: "POST",
      url: "/api/card/auth",
      payload: basePayload
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { approved: boolean; auth_status?: string };
    expect(json.approved).toBe(false);
    expect(json.auth_status).toBe("unauthenticated");

    await app.close();
  });

  it("invalid signature rejected", async () => {
    const { app, kernel } = await createApp({
      CARD_MODE: "shadow",
      CARD_WEBHOOK_SHARED_SECRET: "secret"
    });
    kernel.createAgent({ agentId: "agent_1" });
    const basePayload = buildPayload();

    const res = await app.inject({
      method: "POST",
      url: "/api/card/auth",
      headers: {
        "x-card-timestamp": String(basePayload.timestamp),
        "x-card-signature": "bad_signature"
      },
      payload: basePayload
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { approved: boolean; auth_status?: string };
    expect(json.approved).toBe(false);
    expect(json.auth_status).toBe("unauthenticated");

    await app.close();
  });

  it("stale timestamp rejected", async () => {
    const { app, kernel } = await createApp({
      CARD_MODE: "shadow",
      CARD_WEBHOOK_SHARED_SECRET: "secret"
    });
    kernel.createAgent({ agentId: "agent_1" });
    const basePayload = buildPayload();

    const oldTimestamp = String(1);
    const signature = computeCardSignature({
      secret: "secret",
      timestamp: oldTimestamp,
      body: basePayload
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/card/auth",
      headers: {
        "x-card-timestamp": oldTimestamp,
        "x-card-signature": signature
      },
      payload: basePayload
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { approved: boolean; auth_status?: string };
    expect(json.approved).toBe(false);
    expect(json.auth_status).toBe("unauthenticated");

    await app.close();
  });

  it("same auth_id is idempotent", async () => {
    const { app, kernel } = await createApp({
      CARD_MODE: "shadow",
      CARD_WEBHOOK_SHARED_SECRET: "secret"
    });
    kernel.createAgent({ agentId: "agent_1" });
    const basePayload = buildPayload();

    const timestamp = String(basePayload.timestamp);
    const signature = computeCardSignature({
      secret: "secret",
      timestamp,
      body: basePayload
    });

    const res1 = await app.inject({
      method: "POST",
      url: "/api/card/auth",
      headers: {
        "x-card-timestamp": timestamp,
        "x-card-signature": signature
      },
      payload: basePayload
    });
    expect(res1.statusCode).toBe(200);
    const json1 = res1.json() as { approved: boolean; idempotent?: boolean };
    expect(json1.approved).toBe(true);
    expect(json1.idempotent).toBeUndefined();

    const res2 = await app.inject({
      method: "POST",
      url: "/api/card/auth",
      headers: {
        "x-card-timestamp": timestamp,
        "x-card-signature": signature
      },
      payload: basePayload
    });
    const json2 = res2.json() as { approved: boolean; idempotent?: boolean };
    expect(json2.approved).toBe(true);
    expect(json2.idempotent).toBe(true);

    await app.close();
  });
});
