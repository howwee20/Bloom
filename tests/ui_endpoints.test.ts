import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/db/database.js";
import { applyMigrations } from "./helpers.js";
import { buildServer } from "../src/api/server.js";
import { SimpleEconomyWorld } from "../src/env/simple_economy.js";
import type { Config } from "../src/config.js";
import {
  baseUsdcBalanceCache,
  baseUsdcPendingTxs,
  cardHolds
} from "../src/db/schema.js";
import { createReceipt } from "../src/kernel/receipts.js";
import { appendEvent } from "../src/kernel/events.js";
import { nowSeconds } from "../src/kernel/utils.js";
import { mapReasonToHuman } from "../src/presentation/index.js";

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
    DEFAULT_CREDITS_CENTS: 600,
    DEFAULT_DAILY_SPEND_CENTS: 1000,
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
  return { app, db, sqlite, kernel, config };
}

describe("UI endpoints", () => {
  it("formats ui/state spendable, balance, held", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const baseTime = new Date("2025-01-01T00:00:00Z");
    vi.setSystemTime(baseTime);

    const { app, db, kernel } = await createApp();
    const { agent_id } = kernel.createAgent({ userId: "user_ui", agentId: "agent_ui" });

    const keyRes = await app.inject({
      method: "POST",
      url: "/api/admin/keys",
      headers: { "x-admin-key": "adminkey" },
      payload: { user_id: "user_ui", scopes: ["read"] }
    });
    const apiKey = (keyRes.json() as { api_key: string }).api_key;

    const now = nowSeconds();
    db.insert(baseUsdcBalanceCache)
      .values({
        agentId: agent_id,
        confirmedBalanceCents: 800,
        observedBlockNumber: 1,
        observedBlockTimestamp: now,
        updatedAt: now
      })
      .run();

    db.insert(baseUsdcPendingTxs)
      .values({
        id: "pending_tx_1",
        agentId: agent_id,
        quoteId: "quote_ui",
        idempotencyKey: null,
        toAddress: null,
        amountCents: 100,
        txHash: null,
        status: "pending",
        submittedBlockNumber: null,
        confirmedBlockNumber: null,
        createdAt: now,
        updatedAt: now
      })
      .run();

    db.insert(cardHolds)
      .values({
        agentId: agent_id,
        authId: "hold_ui",
        amountCents: 100,
        status: "pending",
        source: "card",
        createdAt: now,
        updatedAt: now
      })
      .run();
    const res = await app.inject({
      method: "GET",
      url: `/api/ui/state?agent_id=${agent_id}`,
      headers: { "x-api-key": apiKey }
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    expect(body.number).toBe("$6.00");
    expect(body.balance).toBe("$8.00 balance");
    expect(body.held).toBe("$2.00 held");
    expect(body.net_worth).toBe("$8.00");
    expect(body.updated).toBe("just now");
    expect(body.details).toEqual({
      spendable_cents: 600,
      balance_cents: 800,
      held_cents: 200
    });

    await app.close();
    vi.useRealTimers();
  });

  it("collapses receipts into ui/activity glance and summary", async () => {
    const { app, db, kernel } = await createApp();
    const { agent_id, user_id } = kernel.createAgent({ userId: "user_ui", agentId: "agent_ui" });

    const keyRes = await app.inject({
      method: "POST",
      url: "/api/admin/keys",
      headers: { "x-admin-key": "adminkey" },
      payload: { user_id: "user_ui", scopes: ["read"] }
    });
    const apiKey = (keyRes.json() as { api_key: string }).api_key;

    const base = nowSeconds();
    createReceipt(db, {
      agentId: agent_id,
      userId: user_id,
      source: "policy",
      externalRef: "quote_ui",
      whatHappened: "Policy approved intent.",
      whyChanged: "constraints_ok",
      whatHappensNext: "Quote issued.",
      occurredAt: base - 3
    });
    createReceipt(db, {
      agentId: agent_id,
      userId: user_id,
      source: "execution",
      externalRef: "quote_ui",
      whatHappened: "Budget reserved for execution.",
      whyChanged: "reserve",
      whatHappensNext: "Environment action will apply.",
      occurredAt: base - 2
    });
    createReceipt(db, {
      agentId: agent_id,
      userId: user_id,
      source: "env",
      externalRef: "quote_ui",
      whatHappened:
        "USDC transfer broadcast. tx_hash=0x352f000000000000000000000000000000000000000000000000000000000000 amount_cents=100 to_address=0x56B0e5Ce4f03a82B5e46ACaE4e93e49Ada453351 observation_unknown",
      whyChanged: "applied",
      whatHappensNext: "Pending confirmation.",
      occurredAt: base - 1
    });
    createReceipt(db, {
      agentId: agent_id,
      userId: user_id,
      source: "execution",
      externalRef: "quote_ui",
      whatHappened: "Execution applied.",
      whyChanged: "applied",
      whatHappensNext: "Observation will reflect changes.",
      occurredAt: base
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/ui/activity?agent_id=${agent_id}&limit=5`,
      headers: { "x-api-key": apiKey }
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Array<Record<string, unknown>>;
    expect(body.length).toBe(1);
    const item = body[0] as {
      line: string;
      status: string;
      summary: string[];
      details: Record<string, string | undefined>;
    };

    expect(item.status).toBe("pending");
    expect(item.line).toBe("Sent $1.00 · 0x56B0…3351 · Pending");
    expect(item.summary.some((entry) => entry.startsWith("Approved"))).toBe(true);
    expect(item.summary.some((entry) => entry.startsWith("Held $1.00"))).toBe(true);
    expect(item.summary.some((entry) => entry.startsWith("Sent $1.00"))).toBe(true);
    expect(item.summary.some((entry) => entry.startsWith("Pending"))).toBe(true);
    expect(item.details.amount).toBe("$1.00");
    expect(item.details.to).toBe("0x56B0…3351");
    expect(item.details.tx_hash?.startsWith("0x352f")).toBe(true);

    await app.close();
  });

  it("groups ui/activity by quote_id from events", async () => {
    const { app, db, sqlite, kernel } = await createApp();
    const { agent_id, user_id } = kernel.createAgent({ userId: "user_ui", agentId: "agent_ui" });

    const keyRes = await app.inject({
      method: "POST",
      url: "/api/admin/keys",
      headers: { "x-admin-key": "adminkey" },
      payload: { user_id: "user_ui", scopes: ["read"] }
    });
    const apiKey = (keyRes.json() as { api_key: string }).api_key;

    const base = nowSeconds();
    const stepUpEvent = appendEvent(db, sqlite, {
      agentId: agent_id,
      userId: user_id,
      type: "step_up_requested",
      payload: { quote_id: "quote_ui", challenge_id: "challenge_ui" },
      occurredAt: base - 2
    });
    createReceipt(db, {
      agentId: agent_id,
      userId: user_id,
      source: "policy",
      eventId: stepUpEvent.event_id,
      externalRef: "challenge_ui",
      whatHappened: "Step-up challenge created.",
      whyChanged: "step_up_requested",
      whatHappensNext: "Approve or deny.",
      occurredAt: base - 2
    });

    const execEvent = appendEvent(db, sqlite, {
      agentId: agent_id,
      userId: user_id,
      type: "execution_applied",
      payload: { quote_id: "quote_ui", exec_id: "exec_ui" },
      occurredAt: base - 1
    });
    createReceipt(db, {
      agentId: agent_id,
      userId: user_id,
      source: "execution",
      eventId: execEvent.event_id,
      externalRef: "order_ui",
      whatHappened: "Execution applied.",
      whyChanged: "applied",
      whatHappensNext: "Observation will reflect changes.",
      occurredAt: base - 1
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/ui/activity?agent_id=${agent_id}&limit=5`,
      headers: { "x-api-key": apiKey }
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Array<Record<string, unknown>>;
    expect(body.length).toBe(1);
    const item = body[0] as { id: string; summary: string[] };
    expect(item.id).toBe("quote_ui");
    expect(item.summary.some((entry) => entry.startsWith("Needs approval"))).toBe(true);
    expect(item.summary.some((entry) => entry.startsWith("Pending"))).toBe(true);

    await app.close();
  });

  it("maps decline reasons to human strings", () => {
    expect(mapReasonToHuman("intent_not_allowlisted")).toBe("Not on your allowlist");
    expect(mapReasonToHuman("insufficient_gas")).toBe("Not enough for network fee");
    expect(mapReasonToHuman("policy_limit_exceeded")).toBe("Exceeds your daily limit");
    expect(mapReasonToHuman("frozen")).toBe("Account frozen");
  });
});
