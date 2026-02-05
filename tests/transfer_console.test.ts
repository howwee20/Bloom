import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db/database.js";
import { applyMigrations } from "./helpers.js";
import { buildServer } from "../src/api/server.js";
import { BaseUsdcWorld } from "../src/env/base_usdc.js";
import type { Config } from "../src/config.js";
import { baseUsdcPendingTxs, quotes, receipts } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { nowSeconds } from "../src/kernel/utils.js";

const TEST_MNEMONIC = "test test test test test test test test test test test junk";

function applyConsoleMigrations(sqlite: import("better-sqlite3").Database) {
  const migrationsDir = path.resolve("src/db/console_migrations");
  const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    sqlite.exec(sql);
  }
}

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
    CONFIRMATIONS_REQUIRED: 0,
    USDC_BUFFER_CENTS: 0,
    DEV_MASTER_MNEMONIC: TEST_MNEMONIC,
    LITHIC_API_KEY: null,
    LITHIC_ASA_SECRET: null,
    LITHIC_API_URL: "https://sandbox.lithic.com",
    ...overrides
  };
}

type FakeClientState = { balance: bigint; gas: bigint; latest: { number: bigint; timestamp: bigint } };

type FakeClient = {
  getBlock: (args: { blockTag?: "latest"; blockNumber?: bigint }) => Promise<{ number: bigint; timestamp: bigint }>;
  getBalance: (args: { address: `0x${string}` }) => Promise<bigint>;
  readContract: (args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: [`0x${string}`];
    blockNumber?: bigint;
  }) => Promise<bigint>;
};

function createFakeClient(state: FakeClientState): FakeClient {
  return {
    getBlock: async ({ blockTag, blockNumber }) => {
      if (blockTag === "latest") return state.latest;
      if (blockNumber !== undefined) return state.latest;
      return state.latest;
    },
    getBalance: async () => state.gas,
    readContract: async () => state.balance
  };
}

async function createApp() {
  const { sqlite, db } = createDatabase(":memory:");
  applyMigrations(sqlite);

  const { sqlite: consoleSqlite, db: consoleDb } = createDatabase(":memory:");
  applyConsoleMigrations(consoleSqlite);

  const now = nowSeconds();
  const clientState: FakeClientState = {
    balance: 2_000_000n,
    gas: 1n,
    latest: { number: 100n, timestamp: BigInt(now - 5) }
  };

  let txCounter = 0;
  const env = new BaseUsdcWorld(db, sqlite, makeConfig(), {
    client: createFakeClient(clientState),
    walletClientFactory: () => ({
      writeContract: async () => {
        const hash = (txCounter++).toString(16).padStart(64, "0");
        return `0x${hash}` as `0x${string}`;
      }
    })
  });

  const { app, kernel } = buildServer({
    config: makeConfig(),
    db,
    sqlite,
    consoleDb,
    consoleSqlite,
    env
  });
  await app.ready();
  return { app, kernel, db, clientState };
}

async function createSession(app: Awaited<ReturnType<typeof createApp>>, userId = "user_console") {
  app.kernel.createAgent({ userId });
  const login = await app.app.inject({ method: "POST", url: "/console/login" });
  expect(login.statusCode).toBe(200);
  const data = login.json() as { session_id: string };
  return data.session_id;
}

describe("Console transfer actions", () => {
  it("quotes without executing", async () => {
    const app = await createApp();
    const sessionId = await createSession(app);

    const quoteRes = await app.app.inject({
      method: "POST",
      url: "/console/actions/transfer/quote",
      headers: { "x-console-session": sessionId },
      payload: {
        amount_cents: 100,
        to_address: "0x1111111111111111111111111111111111111111"
      }
    });
    expect(quoteRes.statusCode).toBe(200);
    const quote = quoteRes.json() as { quote_id: string };
    expect(quote.quote_id).toBeTruthy();

    const pending = app.db.select().from(baseUsdcPendingTxs).all();
    expect(pending.length).toBe(0);

    await app.app.close();
  });

  it("approves and executes with tx hash and record", async () => {
    const app = await createApp();
    const sessionId = await createSession(app);

    const quoteRes = await app.app.inject({
      method: "POST",
      url: "/console/actions/transfer/quote",
      headers: { "x-console-session": sessionId },
      payload: {
        amount_cents: 125,
        to_address: "0x2222222222222222222222222222222222222222"
      }
    });
    const quote = quoteRes.json() as { quote_id: string };

    const approveRes = await app.app.inject({
      method: "POST",
      url: "/console/actions/transfer/approve",
      headers: { "x-console-session": sessionId },
      payload: { quote_id: quote.quote_id }
    });
    expect(approveRes.statusCode).toBe(200);
    const approve = approveRes.json() as { status: string; step_up_id?: string; code?: string };

    let result: { status: string; tx_hash?: string; record_id?: string };
    if (approve.status === "step_up_required") {
      const confirmRes = await app.app.inject({
        method: "POST",
        url: "/console/actions/step_up/confirm",
        headers: { "x-console-session": sessionId },
        payload: { step_up_id: approve.step_up_id, code: approve.code }
      });
      expect(confirmRes.statusCode).toBe(200);
      result = confirmRes.json() as { status: string; tx_hash?: string; record_id?: string };
    } else {
      result = approve as unknown as { status: string; tx_hash?: string; record_id?: string };
    }

    expect(result.status).toBe("executed");
    expect(result.tx_hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.record_id).toBeTruthy();

    const pending = app.db
      .select()
      .from(baseUsdcPendingTxs)
      .where(eq(baseUsdcPendingTxs.quoteId, quote.quote_id))
      .get();
    expect(pending?.txHash).toBe(result.tx_hash);

    const receiptRows = app.db
      .select()
      .from(receipts)
      .where(eq(receipts.externalRef, quote.quote_id))
      .all();
    const hasTxReceipt = receiptRows.some((row) => String(row.whatHappened).includes(`tx_hash=${result.tx_hash}`));
    expect(hasTxReceipt).toBe(true);

    await app.app.close();
  });

  it("rejects expired quotes", async () => {
    const app = await createApp();
    const sessionId = await createSession(app);

    const quoteRes = await app.app.inject({
      method: "POST",
      url: "/console/actions/transfer/quote",
      headers: { "x-console-session": sessionId },
      payload: {
        amount_cents: 100,
        to_address: "0x3333333333333333333333333333333333333333"
      }
    });
    const quote = quoteRes.json() as { quote_id: string };

    app.db
      .update(quotes)
      .set({ expiresAt: nowSeconds() - 10 })
      .where(eq(quotes.quoteId, quote.quote_id))
      .run();

    const approveRes = await app.app.inject({
      method: "POST",
      url: "/console/actions/transfer/approve",
      headers: { "x-console-session": sessionId },
      payload: { quote_id: quote.quote_id }
    });
    expect(approveRes.statusCode).toBe(400);
    expect((approveRes.json() as { error: string }).error).toBe("quote_expired");

    await app.app.close();
  });

  it("rejects approval when available balance drops", async () => {
    const app = await createApp();
    const sessionId = await createSession(app);

    const quoteRes = await app.app.inject({
      method: "POST",
      url: "/console/actions/transfer/quote",
      headers: { "x-console-session": sessionId },
      payload: {
        amount_cents: 150,
        to_address: "0x4444444444444444444444444444444444444444"
      }
    });
    const quote = quoteRes.json() as { quote_id: string };

    app.clientState.balance = 10n;

    const approveRes = await app.app.inject({
      method: "POST",
      url: "/console/actions/transfer/approve",
      headers: { "x-console-session": sessionId },
      payload: { quote_id: quote.quote_id }
    });
    expect(approveRes.statusCode).toBe(200);
    const approve = approveRes.json() as { status: string; step_up_id?: string; code?: string };
    expect(approve.status).toBe("step_up_required");

    const confirmRes = await app.app.inject({
      method: "POST",
      url: "/console/actions/step_up/confirm",
      headers: { "x-console-session": sessionId },
      payload: { step_up_id: approve.step_up_id, code: approve.code }
    });
    expect(confirmRes.statusCode).toBe(400);
    expect((confirmRes.json() as { error: string }).error).toBe("insufficient_confirmed_usdc");

    await app.app.close();
  });

  it("requires a console session even with API key", async () => {
    const app = await createApp();

    const keyRes = await app.app.inject({
      method: "POST",
      url: "/api/admin/keys",
      headers: { "x-admin-key": "adminkey" },
      payload: { user_id: "user_console", scopes: ["*"] }
    });
    const apiKey = (keyRes.json() as { api_key: string }).api_key;

    const quoteRes = await app.app.inject({
      method: "POST",
      url: "/console/actions/transfer/quote",
      headers: { "x-api-key": apiKey },
      payload: {
        amount_cents: 100,
        to_address: "0x5555555555555555555555555555555555555555"
      }
    });
    expect(quoteRes.statusCode).toBe(401);
    expect((quoteRes.json() as { error: string }).error).toBe("console_session_required");

    await app.app.close();
  });
});
