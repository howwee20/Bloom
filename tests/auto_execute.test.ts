import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db/database.js";
import { buildServer } from "../src/api/server.js";
import { BaseUsdcWorld } from "../src/env/base_usdc.js";
import type { Config } from "../src/config.js";
import { applyMigrations } from "./helpers.js";
import { nowSeconds } from "../src/kernel/utils.js";

const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const ALLOW_ADDRESS = "0x56B0e5Ce4f03a82B5e46ACaE4e93e49Ada453351";

type FakeBlock = { number: bigint; timestamp: bigint };
type FakeClient = {
  getBlock: (args: { blockTag?: "latest"; blockNumber?: bigint }) => Promise<FakeBlock>;
  getBalance: (args: { address: `0x${string}` }) => Promise<bigint>;
  readContract: (args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: [`0x${string}`];
    blockNumber?: bigint;
  }) => Promise<bigint>;
};

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
    ENV_TYPE: "base_usdc",
    ENV_STALE_SECONDS: 60,
    ENV_UNKNOWN_SECONDS: 300,
    STEP_UP_SHARED_SECRET: null,
    STEP_UP_CHALLENGE_TTL_SECONDS: 120,
    STEP_UP_TOKEN_TTL_SECONDS: 60,
    DEFAULT_CREDITS_CENTS: 100000,
    DEFAULT_DAILY_SPEND_CENTS: 100000,
    BASE_RPC_URL: "http://localhost:8545",
    BASE_CHAIN: "base_sepolia",
    BASE_USDC_CONTRACT: "0x0000000000000000000000000000000000000001",
    CONFIRMATIONS_REQUIRED: 5,
    USDC_BUFFER_CENTS: 0,
    DEV_MASTER_MNEMONIC: TEST_MNEMONIC,
    BLOOM_ALLOW_TRANSFER: true,
    BLOOM_ALLOW_TRANSFER_AGENT_IDS: ["agent_ej"],
    BLOOM_ALLOW_TRANSFER_TO: [ALLOW_ADDRESS.toLowerCase()],
    BLOOM_AUTO_APPROVE_TRANSFER_MAX_CENTS: 200,
    BLOOM_AUTO_APPROVE_AGENT_IDS: ["agent_ej"],
    BLOOM_AUTO_APPROVE_TO: [ALLOW_ADDRESS.toLowerCase()],
    BLOOM_ALLOW_POLYMARKET: false,
    BLOOM_ALLOW_POLYMARKET_AGENT_IDS: [],
    POLY_DRYRUN_MAX_PER_ORDER_CENTS: 500,
    POLY_DRYRUN_MAX_OPEN_HOLDS_CENTS: 2000,
    POLY_DRYRUN_MAX_OPEN_ORDERS: 20,
    POLY_DRYRUN_LOOP_SECONDS: 30,
    ...overrides
  };
}

function createFakeClient(now: number, balanceUnits = 500_000_000n): FakeClient {
  return {
    getBlock: async () => ({ number: 400n, timestamp: BigInt(now - 5) }),
    getBalance: async () => 1n,
    readContract: async () => balanceUnits
  };
}

async function createApp(overrides: Partial<Config> = {}) {
  const { sqlite, db } = createDatabase(":memory:");
  applyMigrations(sqlite);
  const config = makeConfig(overrides);
  const now = nowSeconds();
  const client = createFakeClient(now);
  const walletClientFactory = () => ({
    writeContract: async () =>
      "0xabc0000000000000000000000000000000000000000000000000000000000000" as `0x${string}`
  });
  const env = new BaseUsdcWorld(db, sqlite, config, { client, walletClientFactory });
  const { app } = buildServer({ config, db, sqlite, env });
  await app.ready();
  return { app };
}

async function createKey(app: Awaited<ReturnType<typeof createApp>>["app"], scopes: string[], userId?: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/admin/keys",
    headers: { "x-admin-key": "adminkey" },
    payload: { user_id: userId, scopes }
  });
  return res.json() as { api_key: string; user_id: string };
}

describe("auto_execute + step_up approve", () => {
  it("auto-executes allowlisted small transfer", async () => {
    const { app } = await createApp();
    const proposeKey = await createKey(app, ["propose"]);

    await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "x-api-key": proposeKey.api_key },
      payload: { agent_id: "agent_ej" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/auto_execute",
      headers: { "x-api-key": proposeKey.api_key },
      payload: {
        agent_id: "agent_ej",
        intent_json: {
          type: "send_usdc",
          to_address: ALLOW_ADDRESS,
          amount_cents: 100
        }
      }
    });
    const body = res.json() as { execution?: { status: string }; auto_approved: boolean };
    expect(body.auto_approved).toBe(true);
    expect(body.execution?.status).toBe("applied");
  });

  it("requires step-up for transfers above auto-approve max", async () => {
    const { app } = await createApp({ BLOOM_AUTO_APPROVE_TRANSFER_MAX_CENTS: 50 });
    const proposeKey = await createKey(app, ["propose"]);

    await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "x-api-key": proposeKey.api_key },
      payload: { agent_id: "agent_ej" }
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/auto_execute",
      headers: { "x-api-key": proposeKey.api_key },
      payload: {
        agent_id: "agent_ej",
        intent_json: {
          type: "base_usdc_send",
          to_address: ALLOW_ADDRESS,
          amount_cents: 100
        }
      }
    });
    const body = res.json() as { execution: null; step_up_required: boolean };
    expect(body.step_up_required).toBe(true);
    expect(body.execution).toBeNull();
  });

  it("admin step_up approve mints token and enables execute", async () => {
    const { app } = await createApp();
    const proposeKey = await createKey(app, ["propose"]);
    const executeKey = await createKey(app, ["execute"], proposeKey.user_id);

    await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "x-api-key": proposeKey.api_key },
      payload: { agent_id: "agent_ej" }
    });

    const quoteRes = await app.inject({
      method: "POST",
      url: "/api/can_do",
      headers: { "x-api-key": proposeKey.api_key },
      payload: {
        agent_id: "agent_ej",
        intent_json: {
          type: "send_usdc",
          to_address: ALLOW_ADDRESS,
          amount_cents: 100
        }
      }
    });
    const quote = quoteRes.json() as { quote_id: string; idempotency_key: string };

    const approveRes = await app.inject({
      method: "POST",
      url: "/api/step_up/approve",
      headers: { "x-admin-key": "adminkey" },
      payload: { quote_id: quote.quote_id, approve: true }
    });
    const approveBody = approveRes.json() as { step_up_token: string };

    const execRes = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-api-key": executeKey.api_key },
      payload: {
        quote_id: quote.quote_id,
        idempotency_key: quote.idempotency_key,
        step_up_token: approveBody.step_up_token
      }
    });
    const execBody = execRes.json() as { status: string };
    expect(execBody.status).toBe("applied");
  });
});
