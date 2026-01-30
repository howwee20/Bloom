import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db/database.js";
import { applyMigrations } from "./helpers.js";
import { buildServer } from "../src/api/server.js";
import { SimpleEconomyWorld } from "../src/env/simple_economy.js";
import type { Config } from "../src/config.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    DB_PATH: ":memory:",
    PORT: 0,
    ADMIN_API_KEY: "adminkey",
    ENV_TYPE: "simple_economy",
    ENV_STALE_SECONDS: 60,
    ENV_UNKNOWN_SECONDS: 300,
    STEP_UP_SHARED_SECRET: null,
    DEFAULT_CREDITS_CENTS: 5000,
    DEFAULT_DAILY_SPEND_CENTS: 2000,
    BASE_RPC_URL: null,
    BASE_CHAIN: "base_sepolia",
    BASE_USDC_CONTRACT: null,
    CONFIRMATIONS_REQUIRED: 5,
    USDC_BUFFER_CENTS: 0,
    DEV_MASTER_MNEMONIC: null,
    ...overrides
  };
}

async function createApp() {
  const { sqlite, db } = createDatabase(":memory:");
  applyMigrations(sqlite);
  const config = makeConfig();
  const env = new SimpleEconomyWorld(db, sqlite, config);
  const { app } = buildServer({ config, db, sqlite, env });
  await app.ready();
  return { app };
}

describe("API auth + ownership", () => {
  it("rejects requests without API key", async () => {
    const { app } = await createApp();
    const res = await app.inject({ method: "POST", url: "/api/agents", payload: {} });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("protects admin endpoints with ADMIN_API_KEY", async () => {
    const { app } = await createApp();
    const res = await app.inject({ method: "POST", url: "/api/admin/keys", payload: { user_id: "user_a" } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("enforces agent ownership", async () => {
    const { app } = await createApp();
    const keyResA = await app.inject({
      method: "POST",
      url: "/api/admin/keys",
      headers: { "x-admin-key": "adminkey" },
      payload: { user_id: "user_a" }
    });
    const keyA = (keyResA.json() as { api_key: string }).api_key;

    const keyResB = await app.inject({
      method: "POST",
      url: "/api/admin/keys",
      headers: { "x-admin-key": "adminkey" },
      payload: { user_id: "user_b" }
    });
    const keyB = (keyResB.json() as { api_key: string }).api_key;

    const agentRes = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "x-api-key": keyA },
      payload: {}
    });
    const agentId = (agentRes.json() as { agent_id: string }).agent_id;

    const forbidden = await app.inject({
      method: "GET",
      url: `/api/state?agent_id=${agentId}`,
      headers: { "x-api-key": keyB }
    });
    expect(forbidden.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "GET",
      url: `/api/state?agent_id=${agentId}`,
      headers: { "x-api-key": keyA }
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });
});
