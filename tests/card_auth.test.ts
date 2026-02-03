import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db/database.js";
import { applyMigrations } from "./helpers.js";
import { buildServer } from "../src/api/server.js";
import { SimpleEconomyWorld } from "../src/env/simple_economy.js";
import type { Config } from "../src/config.js";
import { agentSpendSnapshot, cardHolds, events, receipts } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
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

async function createApp() {
  const { sqlite, db } = createDatabase(":memory:");
  applyMigrations(sqlite);
  const config = makeConfig();
  const env = new SimpleEconomyWorld(db, sqlite, config);
  const { app, kernel } = buildServer({ config, db, sqlite, env });
  await app.ready();
  return { app, db, sqlite, kernel };
}

describe("Card auth shadow mode", () => {
  it("records holds, updates snapshot, and logs receipts", async () => {
    const { app, db, kernel } = await createApp();
    const { agent_id, user_id } = kernel.createAgent();

    const now = nowSeconds();
    db.update(agentSpendSnapshot)
      .set({
        confirmedBalanceCents: 10_000,
        reservedOutgoingCents: 0,
        reservedHoldsCents: 0,
        policySpendableCents: 10_000,
        effectiveSpendPowerCents: 10_000,
        updatedAt: now
      })
      .where(eq(agentSpendSnapshot.agentId, agent_id))
      .run();

    const res1 = await app.inject({
      method: "POST",
      url: "/api/card/auth",
      headers: { "x-admin-key": "adminkey" },
      payload: {
        auth_id: "auth_1",
        card_id: "card_1",
        agent_id,
        merchant: "Test",
        mcc: "5812",
        amount_cents: 6000,
        currency: "USD",
        timestamp: now
      }
    });
    expect(res1.statusCode).toBe(200);
    const json1 = res1.json() as { approved: boolean; would_approve: boolean };
    expect(json1.approved).toBe(true);
    expect(json1.would_approve).toBe(true);

    const holdRows = db.select().from(cardHolds).where(eq(cardHolds.agentId, agent_id)).all();
    expect(holdRows.length).toBe(1);

    const snapshotAfter = db
      .select()
      .from(agentSpendSnapshot)
      .where(eq(agentSpendSnapshot.agentId, agent_id))
      .get();
    expect(snapshotAfter?.reservedHoldsCents).toBe(6000);
    expect((snapshotAfter?.effectiveSpendPowerCents ?? 0) <= 4000).toBe(true);

    const res2 = await app.inject({
      method: "POST",
      url: "/api/card/auth",
      headers: { "x-admin-key": "adminkey" },
      payload: {
        auth_id: "auth_2",
        card_id: "card_1",
        agent_id,
        merchant: "Test",
        mcc: "5812",
        amount_cents: 5000,
        currency: "USD",
        timestamp: now
      }
    });
    const json2 = res2.json() as { approved: boolean; would_approve: boolean; would_decline_reason?: string };
    expect(json2.approved).toBe(true);
    expect(json2.would_approve).toBe(false);
    expect(json2.would_decline_reason).toBeTruthy();

    const eventRows = db.select().from(events).where(eq(events.agentId, agent_id)).all();
    const eventTypes = new Set(eventRows.map((row) => row.type));
    expect(eventTypes.has("card_auth_shadow")).toBe(true);

    const receiptRows = db.select().from(receipts).where(eq(receipts.agentId, agent_id)).all();
    expect(receiptRows.length).toBeGreaterThan(0);

    await app.close();
  });
});
