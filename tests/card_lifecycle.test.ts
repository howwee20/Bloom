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

async function seedHold(db: ReturnType<typeof createDatabase>["db"], agentId: string, authId: string, amountCents: number) {
  const now = nowSeconds();
  db.insert(cardHolds)
    .values({
      authId,
      agentId,
      amountCents,
      status: "pending",
      createdAt: now,
      updatedAt: now
    })
    .run();

  db.update(agentSpendSnapshot)
    .set({
      confirmedBalanceCents: 10_000,
      reservedOutgoingCents: 0,
      reservedHoldsCents: amountCents,
      policySpendableCents: 10_000,
      effectiveSpendPowerCents: 10_000 - amountCents,
      updatedAt: now
    })
    .where(eq(agentSpendSnapshot.agentId, agentId))
    .run();
}

describe("Card lifecycle endpoints", () => {
  it("pending -> settled updates snapshot and receipts", async () => {
    const { app, db, kernel } = await createApp();
    const { agent_id } = kernel.createAgent();
    await seedHold(db, agent_id, "auth_settle", 3000);

    const res = await app.inject({
      method: "POST",
      url: "/api/card/settle",
      headers: { "x-admin-key": "adminkey" },
      payload: {
        agent_id: agent_id,
        auth_id: "auth_settle",
        settled_amount_cents: 2800,
        settled_at: nowSeconds()
      }
    });
    expect(res.statusCode).toBe(200);

    const hold = db.select().from(cardHolds).where(eq(cardHolds.authId, "auth_settle")).get();
    expect(hold?.status).toBe("settled");

    const snapshot = db
      .select()
      .from(agentSpendSnapshot)
      .where(eq(agentSpendSnapshot.agentId, agent_id))
      .get();
    expect(snapshot?.reservedHoldsCents).toBe(0);

    const eventRows = db.select().from(events).where(eq(events.agentId, agent_id)).all();
    expect(eventRows.some((row) => row.type === "card_settled")).toBe(true);

    const receiptRows = db.select().from(receipts).where(eq(receipts.agentId, agent_id)).all();
    expect(receiptRows.some((row) => row.whyChanged === "card_settled")).toBe(true);

    await app.close();
  });

  it("pending -> released updates snapshot and receipts", async () => {
    const { app, db, kernel } = await createApp();
    const { agent_id } = kernel.createAgent();
    await seedHold(db, agent_id, "auth_release", 4000);

    const res = await app.inject({
      method: "POST",
      url: "/api/card/release",
      headers: { "x-admin-key": "adminkey" },
      payload: {
        agent_id: agent_id,
        auth_id: "auth_release",
        reason: "expired",
        released_at: nowSeconds()
      }
    });
    expect(res.statusCode).toBe(200);

    const hold = db.select().from(cardHolds).where(eq(cardHolds.authId, "auth_release")).get();
    expect(hold?.status).toBe("released");

    const snapshot = db
      .select()
      .from(agentSpendSnapshot)
      .where(eq(agentSpendSnapshot.agentId, agent_id))
      .get();
    expect(snapshot?.reservedHoldsCents).toBe(0);

    const eventRows = db.select().from(events).where(eq(events.agentId, agent_id)).all();
    expect(eventRows.some((row) => row.type === "card_released")).toBe(true);

    const receiptRows = db.select().from(receipts).where(eq(receipts.agentId, agent_id)).all();
    expect(receiptRows.some((row) => row.whyChanged === "card_released")).toBe(true);

    await app.close();
  });

  it("settle after release fails deterministically", async () => {
    const { app, db, kernel } = await createApp();
    const { agent_id } = kernel.createAgent();
    await seedHold(db, agent_id, "auth_block_settle", 1500);

    await app.inject({
      method: "POST",
      url: "/api/card/release",
      headers: { "x-admin-key": "adminkey" },
      payload: {
        agent_id: agent_id,
        auth_id: "auth_block_settle",
        reason: "voided",
        released_at: nowSeconds()
      }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/card/settle",
      headers: { "x-admin-key": "adminkey" },
      payload: {
        agent_id: agent_id,
        auth_id: "auth_block_settle",
        settled_amount_cents: 1500,
        settled_at: nowSeconds()
      }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "hold_not_pending" });

    await app.close();
  });

  it("release after settle fails deterministically", async () => {
    const { app, db, kernel } = await createApp();
    const { agent_id } = kernel.createAgent();
    await seedHold(db, agent_id, "auth_block_release", 2000);

    await app.inject({
      method: "POST",
      url: "/api/card/settle",
      headers: { "x-admin-key": "adminkey" },
      payload: {
        agent_id: agent_id,
        auth_id: "auth_block_release",
        settled_amount_cents: 2000,
        settled_at: nowSeconds()
      }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/card/release",
      headers: { "x-admin-key": "adminkey" },
      payload: {
        agent_id: agent_id,
        auth_id: "auth_block_release",
        reason: "reversed",
        released_at: nowSeconds()
      }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "hold_not_pending" });

    await app.close();
  });

  it("requires x-admin-key", async () => {
    const { app, db, kernel } = await createApp();
    const { agent_id } = kernel.createAgent();
    await seedHold(db, agent_id, "auth_admin", 1200);

    const res = await app.inject({
      method: "POST",
      url: "/api/card/settle",
      payload: {
        agent_id: agent_id,
        auth_id: "auth_admin",
        settled_amount_cents: 1200,
        settled_at: nowSeconds()
      }
    });
    expect(res.statusCode).toBe(403);

    await app.close();
  });
});
