import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/db/database.js";
import { applyMigrations } from "./helpers.js";
import { SimpleEconomyWorld } from "../src/env/simple_economy.js";
import type { Config } from "../src/config.js";
import { agentSpendSnapshot } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

let uuidCounter = 0;

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomUUID: () => `00000000-0000-0000-0000-${String(uuidCounter++).padStart(12, "0")}`
  };
});

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    API_VERSION: "0.1.0-alpha",
    DB_PATH: ":memory:",
    CONSOLE_DB_PATH: ":memory:",
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
    DEFAULT_CREDITS_CENTS: 50000,
    DEFAULT_DAILY_SPEND_CENTS: 50000,
    BASE_RPC_URL: null,
    BASE_CHAIN: "base_sepolia",
    BASE_USDC_CONTRACT: null,
    CONFIRMATIONS_REQUIRED: 5,
    USDC_BUFFER_CENTS: 0,
    DEV_MASTER_MNEMONIC: null,
    LITHIC_API_KEY: null,
    LITHIC_ASA_SECRET: null,
    LITHIC_API_URL: "https://sandbox.lithic.com",
    ANTHROPIC_API_KEY: null,
    ANTHROPIC_MODEL: "claude-3-5-sonnet-20240620",
    CONSOLE_BOOTSTRAP_TOKEN: null,
    CONSOLE_PASSWORD: null,
    CONSOLE_SESSION_TTL_SECONDS: 12 * 60 * 60,
    ...overrides
  };
}

async function createApp() {
  const { buildServer } = await import("../src/api/server.js");
  const { sqlite, db } = createDatabase(":memory:");
  applyMigrations(sqlite);
  const config = makeConfig();
  const env = new SimpleEconomyWorld(db, sqlite, config);
  const { app } = buildServer({ config, db, sqlite, env });
  await app.ready();
  return { app, db, sqlite };
}

function seconds(date: Date) {
  return Math.floor(date.getTime() / 1000);
}

describe("Kernel contract snapshots", () => {
  it("matches summary/timeline/receipt outputs", async () => {
    uuidCounter = 0;
    vi.useFakeTimers({ toFake: ["Date"] });

    const baseTime = new Date("2025-01-01T00:00:00Z");
    vi.setSystemTime(baseTime);

    const { app, db } = await createApp();

    try {
      const keyRes = await app.inject({
        method: "POST",
        url: "/api/admin/keys",
        headers: { "x-admin-key": "adminkey" },
        payload: { user_id: "user_contract", scopes: ["read", "propose", "execute", "owner"] }
      });
      const apiKey = (keyRes.json() as { api_key: string }).api_key;

      const agentRes = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: { "x-api-key": apiKey },
        payload: { user_id: "user_contract", agent_id: "agent_contract" }
      });
      const agentId = (agentRes.json() as { agent_id: string }).agent_id;

      db.update(agentSpendSnapshot)
        .set({
          confirmedBalanceCents: 100000,
          reservedOutgoingCents: 0,
          reservedHoldsCents: 0,
          policySpendableCents: 50000,
          effectiveSpendPowerCents: 50000,
          updatedAt: seconds(baseTime)
        })
        .where(eq(agentSpendSnapshot.agentId, agentId))
        .run();

      const authTimeA1 = new Date("2025-01-01T00:00:10Z");
      vi.setSystemTime(authTimeA1);
      await app.inject({
        method: "POST",
        url: "/api/card/auth",
        payload: {
          auth_id: "A1",
          card_id: "card_contract",
          agent_id: agentId,
          merchant: "Coffee",
          mcc: "5812",
          amount_cents: 1500,
          currency: "USD",
          timestamp: seconds(authTimeA1)
        }
      });

      const authTimeA2 = new Date("2025-01-01T00:00:20Z");
      vi.setSystemTime(authTimeA2);
      await app.inject({
        method: "POST",
        url: "/api/card/auth",
        payload: {
          auth_id: "A2",
          card_id: "card_contract",
          agent_id: agentId,
          merchant: "Dinner",
          mcc: "5812",
          amount_cents: 2000,
          currency: "USD",
          timestamp: seconds(authTimeA2)
        }
      });

      const settleTime = new Date("2025-01-01T00:00:30Z");
      vi.setSystemTime(settleTime);
      await app.inject({
        method: "POST",
        url: "/api/card/settle",
        headers: { "x-admin-key": "adminkey" },
        payload: {
          agent_id: agentId,
          auth_id: "A1",
          settled_amount_cents: 1450,
          settled_at: seconds(settleTime)
        }
      });

      const releaseTime = new Date("2025-01-01T00:00:40Z");
      vi.setSystemTime(releaseTime);
      await app.inject({
        method: "POST",
        url: "/api/card/release",
        headers: { "x-admin-key": "adminkey" },
        payload: {
          agent_id: agentId,
          auth_id: "A2",
          reason: "voided",
          released_at: seconds(releaseTime)
        }
      });

      const readTime = new Date("2025-01-01T00:00:50Z");
      vi.setSystemTime(readTime);

      const summaryRes = await app.inject({
        method: "GET",
        url: `/api/agents/${agentId}/summary?window=1d`,
        headers: { "x-api-key": apiKey }
      });
      expect(summaryRes.statusCode).toBe(200);
      const summary = summaryRes.json();

      const timelineRes = await app.inject({
        method: "GET",
        url: `/api/agents/${agentId}/timeline?since=0&limit=20`,
        headers: { "x-api-key": apiKey }
      });
      expect(timelineRes.statusCode).toBe(200);
      const timelinePayload = timelineRes.json() as { timeline: Array<{ id: string; kind: string }> };

      const receiptItem = timelinePayload.timeline.find((item) => item.kind === "receipt");
      expect(receiptItem).toBeTruthy();

      const receiptRes = await app.inject({
        method: "GET",
        url: `/api/agents/${agentId}/receipt/${receiptItem?.id}`,
        headers: { "x-api-key": apiKey }
      });
      expect(receiptRes.statusCode).toBe(200);
      const receipt = receiptRes.json();

      expect(summary).toMatchSnapshot("summary");
      expect(timelinePayload).toMatchSnapshot("timeline");
      expect(receipt).toMatchSnapshot("receipt");
    } finally {
      await app.close();
      vi.useRealTimers();
    }
  });
});
