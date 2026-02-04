import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db/database.js";
import { applyMigrations } from "./helpers.js";
import { BaseUsdcWorld } from "../src/env/base_usdc.js";
import { Kernel } from "../src/kernel/kernel.js";
import type { Config } from "../src/config.js";
import { baseUsdcPendingTxs, events, receipts } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { nowSeconds } from "../src/kernel/utils.js";
import { reconcileBaseUsdcPendingTxs } from "../src/workers/reconcile_base_usdc.js";

const TEST_MNEMONIC = "test test test test test test test test test test test junk";

type FakeBlock = { number: bigint; timestamp: bigint };
type FakeEnvClient = {
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
    CONSOLE_DB_PATH: ":memory:",
    PORT: 0,
    APPROVAL_UI_PORT: 0,
    BIND_APPROVAL_UI: false,
    CARD_MODE: "dev",
    CARD_WEBHOOK_SHARED_SECRET: null,
    ADMIN_API_KEY: null,
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
    LITHIC_API_KEY: null,
    LITHIC_ASA_SECRET: null,
    LITHIC_API_URL: "https://sandbox.lithic.com",
    ...overrides
  };
}

function createEnvClient(now: number, balanceUnits: bigint): FakeEnvClient {
  return {
    getBlock: async ({ blockTag, blockNumber }) => {
      if (blockTag === "latest") return { number: 200n, timestamp: BigInt(now - 5) };
      return { number: blockNumber ?? 200n, timestamp: BigInt(now - 20) };
    },
    getBalance: async () => 1n,
    readContract: async () => balanceUnits
  };
}

function createBaseUsdcKernel(envClient: FakeEnvClient, overrides: Partial<Config> = {}) {
  const { sqlite, db } = createDatabase(":memory:");
  applyMigrations(sqlite);
  const config = makeConfig(overrides);
  const env = new BaseUsdcWorld(db, sqlite, config, { client: envClient });
  const kernel = new Kernel(db, sqlite, env, config);
  return { sqlite, db, env, kernel, config };
}

describe("BaseUsdc reconcile worker", () => {
  it("confirms pending txs and releases reserves", async () => {
    const now = nowSeconds();
    const envClient = createEnvClient(now, 100_000_000n);
    const { db, sqlite, kernel, config } = createBaseUsdcKernel(envClient);
    const { agent_id } = kernel.createAgent();

    db.insert(baseUsdcPendingTxs).values({
      id: "tx_1",
      agentId: agent_id,
      amountCents: 2500,
      toAddress: "0x1111111111111111111111111111111111111111",
      txHash: "0xabc0000000000000000000000000000000000000000000000000000000000000",
      status: "pending",
      createdAt: now,
      updatedAt: now
    }).run();

    const beforeState = await kernel.getState(agent_id);
    const beforeSpend = beforeState.spend_power as { reserved_outgoing_cents?: number };
    expect(beforeSpend.reserved_outgoing_cents).toBe(2500);

    const reconcileClient = {
      getBlockNumber: async () => 210n,
      getTransactionReceipt: async () => ({
        blockNumber: 200n,
        status: "success"
      })
    };

    const result = await reconcileBaseUsdcPendingTxs({ db, sqlite, config, client: reconcileClient });
    expect(result.confirmed).toBe(1);

    const pendingRow = db.select().from(baseUsdcPendingTxs).where(eq(baseUsdcPendingTxs.id, "tx_1")).get();
    expect(pendingRow?.status).toBe("confirmed");
    expect(pendingRow?.confirmedBlockNumber).toBe(200);

    const afterState = await kernel.getState(agent_id);
    const afterSpend = afterState.spend_power as { reserved_outgoing_cents?: number };
    expect(afterSpend.reserved_outgoing_cents).toBe(0);

    const eventRows = db.select().from(events).where(eq(events.agentId, agent_id)).all();
    const confirmEvent = eventRows.find((row) => row.type === "usdc_transfer_confirmed");
    expect(confirmEvent).toBeTruthy();

    const receiptRows = db.select().from(receipts).where(eq(receipts.agentId, agent_id)).all();
    const reconcileReceipt = receiptRows.find((row) => row.whyChanged === "reconcile_confirmed");
    expect(reconcileReceipt).toBeTruthy();
  });

  it("marks reverted txs as failed and releases reserves", async () => {
    const now = nowSeconds();
    const envClient = createEnvClient(now, 100_000_000n);
    const { db, sqlite, kernel, config } = createBaseUsdcKernel(envClient);
    const { agent_id } = kernel.createAgent();

    db.insert(baseUsdcPendingTxs).values({
      id: "tx_2",
      agentId: agent_id,
      amountCents: 1500,
      toAddress: "0x1111111111111111111111111111111111111111",
      txHash: "0xdef0000000000000000000000000000000000000000000000000000000000000",
      status: "pending",
      createdAt: now,
      updatedAt: now
    }).run();

    const reconcileClient = {
      getBlockNumber: async () => 210n,
      getTransactionReceipt: async () => ({
        blockNumber: 200n,
        status: "reverted"
      })
    };

    const result = await reconcileBaseUsdcPendingTxs({ db, sqlite, config, client: reconcileClient });
    expect(result.failed).toBe(1);

    const pendingRow = db.select().from(baseUsdcPendingTxs).where(eq(baseUsdcPendingTxs.id, "tx_2")).get();
    expect(pendingRow?.status).toBe("failed");

    const afterState = await kernel.getState(agent_id);
    const afterSpend = afterState.spend_power as { reserved_outgoing_cents?: number };
    expect(afterSpend.reserved_outgoing_cents).toBe(0);

    const eventRows = db.select().from(events).where(eq(events.agentId, agent_id)).all();
    const failEvent = eventRows.find((row) => row.type === "usdc_transfer_reverted");
    expect(failEvent).toBeTruthy();

    const receiptRows = db.select().from(receipts).where(eq(receipts.agentId, agent_id)).all();
    const reconcileReceipt = receiptRows.find((row) => row.whyChanged === "reconcile_reverted");
    expect(reconcileReceipt).toBeTruthy();
  });
});
