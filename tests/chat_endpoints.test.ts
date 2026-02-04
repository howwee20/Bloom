import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db/database.js";
import { applyMigrations } from "./helpers.js";
import { buildServer } from "../src/api/server.js";
import { SimpleEconomyWorld } from "../src/env/simple_economy.js";
import type { Config } from "../src/config.js";
import { appendEvent } from "../src/kernel/events.js";
import { createReceipt } from "../src/kernel/receipts.js";
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
    ANTHROPIC_API_KEY: null,
    ANTHROPIC_MODEL: "claude-3-5-sonnet-20240620",
    CONSOLE_BOOTSTRAP_TOKEN: null,
    CONSOLE_PASSWORD: null,
    CONSOLE_SESSION_TTL_SECONDS: 12 * 60 * 60,
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

describe("Chat-first endpoints", () => {
  it("returns summary and timeline with stable ordering", async () => {
    const { app, kernel, db, sqlite } = await createApp();

    const keyRes = await app.inject({
      method: "POST",
      url: "/api/admin/keys",
      headers: { "x-admin-key": "adminkey" },
      payload: { user_id: "user_chat", scopes: ["read", "propose", "execute"] }
    });
    const apiKey = (keyRes.json() as { api_key: string }).api_key;

    const { user_id, agent_id } = kernel.createAgent({ userId: "user_chat" });

    const now = nowSeconds();
    const evt1 = appendEvent(db, sqlite, {
      agentId: agent_id,
      userId: user_id,
      type: "chat_test_event",
      payload: { seq: 1 },
      occurredAt: now - 10
    });
    createReceipt(db, {
      agentId: agent_id,
      userId: user_id,
      source: "policy",
      eventId: evt1.event_id,
      whatHappened: "Older receipt.",
      whyChanged: "test_old",
      whatHappensNext: "None.",
      occurredAt: now - 10
    });

    const evt2 = appendEvent(db, sqlite, {
      agentId: agent_id,
      userId: user_id,
      type: "chat_test_event",
      payload: { seq: 2 },
      occurredAt: now
    });
    createReceipt(db, {
      agentId: agent_id,
      userId: user_id,
      source: "policy",
      eventId: evt2.event_id,
      whatHappened: "Newer receipt.",
      whyChanged: "test_new",
      whatHappensNext: "None.",
      occurredAt: now
    });

    const summaryRes = await app.inject({
      method: "GET",
      url: `/api/agents/${agent_id}/summary?window=1d`,
      headers: { "x-api-key": apiKey }
    });
    expect(summaryRes.statusCode).toBe(200);
    const summary = summaryRes.json() as Record<string, unknown>;
    expect(summary).toHaveProperty("total_spent_cents");
    expect(summary).toHaveProperty("effective_spend_power_cents");

    const timelineRes = await app.inject({
      method: "GET",
      url: `/api/agents/${agent_id}/timeline?since=0&limit=10`,
      headers: { "x-api-key": apiKey }
    });
    expect(timelineRes.statusCode).toBe(200);
    const timeline = (timelineRes.json() as { timeline: Array<{ ts: number }> }).timeline;
    expect(timeline.length).toBeGreaterThan(0);
    for (let i = 1; i < timeline.length; i += 1) {
      expect(timeline[i - 1]?.ts).toBeGreaterThanOrEqual(timeline[i]?.ts ?? 0);
    }

    await app.close();
  });

  it("enforces access control on summary/receipt", async () => {
    const { app, kernel } = await createApp();

    const keyResA = await app.inject({
      method: "POST",
      url: "/api/admin/keys",
      headers: { "x-admin-key": "adminkey" },
      payload: { user_id: "user_a", scopes: ["read"] }
    });
    const keyA = (keyResA.json() as { api_key: string }).api_key;

    const keyResB = await app.inject({
      method: "POST",
      url: "/api/admin/keys",
      headers: { "x-admin-key": "adminkey" },
      payload: { user_id: "user_b", scopes: ["read"] }
    });
    const keyB = (keyResB.json() as { api_key: string }).api_key;

    const { agent_id } = kernel.createAgent({ userId: "user_a" });

    const summaryForbidden = await app.inject({
      method: "GET",
      url: `/api/agents/${agent_id}/summary?window=1d`,
      headers: { "x-api-key": keyB }
    });
    expect(summaryForbidden.statusCode).toBe(403);

    const summaryAllowed = await app.inject({
      method: "GET",
      url: `/api/agents/${agent_id}/summary?window=1d`,
      headers: { "x-api-key": keyA }
    });
    expect(summaryAllowed.statusCode).toBe(200);

    await app.close();
  });
});
