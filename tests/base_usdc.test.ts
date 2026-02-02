import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db/database.js";
import { applyMigrations } from "./helpers.js";
import { BaseUsdcWorld } from "../src/env/base_usdc.js";
import type { Config } from "../src/config.js";
import { baseUsdcActionDedup, baseUsdcBalanceCache, baseUsdcPendingTxs, baseUsdcWallets, receipts } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { nowSeconds } from "../src/kernel/utils.js";
import { Kernel } from "../src/kernel/kernel.js";

const TEST_MNEMONIC = "test test test test test test test test test test test junk";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    API_VERSION: "0.1.0-alpha",
    DB_PATH: ":memory:",
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
    DEFAULT_CREDITS_CENTS: 0,
    DEFAULT_DAILY_SPEND_CENTS: 0,
    BASE_RPC_URL: "http://localhost:8545",
    BASE_CHAIN: "base_sepolia",
    BASE_USDC_CONTRACT: "0x0000000000000000000000000000000000000001",
    CONFIRMATIONS_REQUIRED: 5,
    USDC_BUFFER_CENTS: 0,
    DEV_MASTER_MNEMONIC: TEST_MNEMONIC,
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

function createFakeClient(options: {
  latest: FakeBlock;
  blocks?: Map<bigint, FakeBlock>;
  balance?: bigint;
  ethBalance?: bigint;
}): FakeClient {
  return {
    getBlock: async ({ blockTag, blockNumber }) => {
      if (blockTag === "latest") return options.latest;
      if (blockNumber !== undefined && options.blocks?.has(blockNumber)) {
        return options.blocks.get(blockNumber) as FakeBlock;
      }
      return options.latest;
    },
    getBalance: async () => options.ethBalance ?? 1n,
    readContract: async () => options.balance ?? 0n
  };
}

function createBaseUsdcKernel(
  client: FakeClient,
  overrides: Partial<Config> = {},
  options: { walletClientFactory?: (account: unknown) => { writeContract: () => Promise<`0x${string}`> } } = {}
) {
  const { sqlite, db } = createDatabase(":memory:");
  applyMigrations(sqlite);
  const config = makeConfig({
    DEFAULT_CREDITS_CENTS: 100000,
    DEFAULT_DAILY_SPEND_CENTS: 100000,
    ...overrides
  });
  const env = new BaseUsdcWorld(db, sqlite, config, {
    client,
    walletClientFactory: options.walletClientFactory as any
  });
  const kernel = new Kernel(db, sqlite, env, config);
  return { sqlite, db, env, kernel, config };
}

async function approveStepUp(input: {
  kernel: Kernel;
  user_id: string;
  agent_id: string;
  quote_id: string;
}) {
  const challenge = await input.kernel.requestStepUpChallenge({
    user_id: input.user_id,
    agent_id: input.agent_id,
    quote_id: input.quote_id
  });
  const approval = await input.kernel.confirmStepUpChallenge({
    challenge_id: challenge.challenge_id,
    code: challenge.code as string,
    decision: "approve"
  });
  if (!approval.ok || !approval.response.step_up_token) {
    throw new Error("step_up_approval_failed");
  }
  return approval.response.step_up_token;
}

describe("BaseUsdcWorld", () => {
  it("classifies freshness from latest block age", async () => {
    const now = nowSeconds();

    const freshClient = createFakeClient({
      latest: { number: 100n, timestamp: BigInt(now - 10) }
    });
    {
      const { sqlite, db } = createDatabase(":memory:");
      applyMigrations(sqlite);
      const env = new BaseUsdcWorld(db, sqlite, makeConfig(), { client: freshClient });
      const freshness = await env.getFreshness();
      expect(freshness.status).toBe("fresh");
    }

    const staleClient = createFakeClient({
      latest: { number: 100n, timestamp: BigInt(now - 120) }
    });
    {
      const { sqlite, db } = createDatabase(":memory:");
      applyMigrations(sqlite);
      const env = new BaseUsdcWorld(db, sqlite, makeConfig(), { client: staleClient });
      const freshness = await env.getFreshness();
      expect(freshness.status).toBe("stale");
    }

    const unknownClient = createFakeClient({
      latest: { number: 100n, timestamp: BigInt(now - 400) }
    });
    {
      const { sqlite, db } = createDatabase(":memory:");
      applyMigrations(sqlite);
      const env = new BaseUsdcWorld(db, sqlite, makeConfig(), { client: unknownClient });
      const freshness = await env.getFreshness();
      expect(freshness.status).toBe("unknown");
    }
  });

  it("derives deterministic per-agent wallet addresses", async () => {
    const now = nowSeconds();
    const client = createFakeClient({
      latest: { number: 42n, timestamp: BigInt(now - 5) },
      balance: 0n
    });
    const { kernel, env, db } = createBaseUsdcKernel(client);
    const { agent_id } = kernel.createAgent();

    const first = await env.getObservation(agent_id);
    const second = await env.getObservation(agent_id);

    expect(first.wallet_address).toEqual(second.wallet_address);
    const rows = db.select().from(baseUsdcWallets).where(eq(baseUsdcWallets.agentId, agent_id)).all();
    expect(rows.length).toBe(1);
  });

  it("converts balances to cents and caches observations", async () => {
    const now = nowSeconds();
    const latest = { number: 100n, timestamp: BigInt(now - 5) };
    const safeBlock = { number: 95n, timestamp: BigInt(now - 20) };
    const blocks = new Map<bigint, FakeBlock>([[95n, safeBlock]]);
    const client = createFakeClient({
      latest,
      blocks,
      balance: 1_234_567n
    });
    const { kernel, env, db } = createBaseUsdcKernel(client, { CONFIRMATIONS_REQUIRED: 5 });
    const { agent_id } = kernel.createAgent();

    const observation = await env.getObservation(agent_id);
    expect(observation.confirmed_balance_cents).toBe(123);
    expect(observation.observed_block_number).toBe(95);
    expect(observation.observed_block_timestamp).toBe(Number(safeBlock.timestamp));

    const cache = db
      .select()
      .from(baseUsdcBalanceCache)
      .where(eq(baseUsdcBalanceCache.agentId, agent_id))
      .get();
    expect(cache?.confirmedBalanceCents).toBe(123);
    expect(cache?.observedBlockNumber).toBe(95);
  });
});

describe("BaseUsdc on-chain bound", () => {
  it("caps spend power by on-chain confirmed balance", async () => {
    const now = nowSeconds();
    const client = createFakeClient({
      latest: { number: 200n, timestamp: BigInt(now - 5) },
      balance: 50_000_000n
    });
    const { kernel } = createBaseUsdcKernel(client);
    const { agent_id } = kernel.createAgent();

    const state = await kernel.getState(agent_id);
    const spend = state.spend_power as {
      policy_spendable_cents?: number;
      effective_spend_power_cents?: number;
      confirmed_balance_cents?: number;
      buffer_cents?: number;
    };
    expect(spend.policy_spendable_cents).toBe(100000);
    expect(spend.effective_spend_power_cents).toBe(5000);
    expect(spend.confirmed_balance_cents).toBe(5000);
    expect(spend.buffer_cents).toBe(0);
  });

  it("reduces spend power by pending reserves", async () => {
    const now = nowSeconds();
    const client = createFakeClient({
      latest: { number: 200n, timestamp: BigInt(now - 5) },
      balance: 50_000_000n
    });
    const { kernel, db } = createBaseUsdcKernel(client);
    const { agent_id } = kernel.createAgent();

    db.insert(baseUsdcPendingTxs).values({
      id: "tx_1",
      agentId: agent_id,
      amountCents: 4000,
      status: "pending",
      createdAt: now,
      updatedAt: now
    }).run();

    const state = await kernel.getState(agent_id);
    const spend = state.spend_power as {
      reserved_outgoing_cents?: number;
      effective_spend_power_cents?: number;
    };
    expect(spend.reserved_outgoing_cents).toBe(4000);
    expect(spend.effective_spend_power_cents).toBe(1000);
  });

  it("blocks can_do when on-chain spend power is lower than intent cost", async () => {
    const now = nowSeconds();
    const client = createFakeClient({
      latest: { number: 200n, timestamp: BigInt(now - 5) },
      balance: 50_000_000n
    });
    const { kernel } = createBaseUsdcKernel(client);
    const { user_id, agent_id } = kernel.createAgent();

    const quote = await kernel.canDo({
      user_id,
      agent_id,
      intent_json: { type: "send_credits", to_agent_id: "agent_target", amount_cents: 6000 }
    });

    expect(quote.allowed).toBe(false);
    expect(quote.reason).toBe("insufficient_confirmed_usdc");
  });

  it("re-checks on execute and blocks if funds changed", async () => {
    const now = nowSeconds();
    let balance = 100_000_000n;
    const client: FakeClient = {
      getBlock: async () => ({ number: 300n, timestamp: BigInt(now - 5) }),
      getBalance: async () => 1n,
      readContract: async () => balance
    };

    const { kernel } = createBaseUsdcKernel(client);
    const { user_id, agent_id } = kernel.createAgent();

    const quote = await kernel.canDo({
      user_id,
      agent_id,
      intent_json: { type: "send_credits", to_agent_id: "agent_target", amount_cents: 6000 }
    });
    expect(quote.allowed).toBe(true);

    balance = 10_000_000n;
    const res = await kernel.execute({ quote_id: quote.quote_id, idempotency_key: quote.idempotency_key });
    expect(res.status).toBe("rejected");
    expect(res.reason).toBe("insufficient_confirmed_usdc");
  });
});

describe("BaseUsdc usdc_transfer", () => {
  const allowTransferConfig = {
    BLOOM_ALLOW_TRANSFER: true,
    BLOOM_ALLOW_TRANSFER_AGENT_IDS: ["agent_ej"],
    BLOOM_ALLOW_TRANSFER_TO: []
  };

  it("denies transfer by default without allowlist", async () => {
    const now = nowSeconds();
    const client = createFakeClient({
      latest: { number: 400n, timestamp: BigInt(now - 5) },
      balance: 500_000_000n,
      ethBalance: 1n
    });
    const { kernel } = createBaseUsdcKernel(client);
    const { user_id, agent_id } = kernel.createAgent({ agentId: "agent_ej" });

    const quote = await kernel.canDo({
      user_id,
      agent_id,
      intent_json: {
        type: "send_usdc",
        to_address: "0x1111111111111111111111111111111111111111",
        amount_cents: 100
      }
    });
    expect(quote.allowed).toBe(false);
    expect(quote.reason).toBe("intent_not_allowlisted");
  });

  it("allows transfer when agent and recipient are allowlisted", async () => {
    const now = nowSeconds();
    const client = createFakeClient({
      latest: { number: 400n, timestamp: BigInt(now - 5) },
      balance: 500_000_000n,
      ethBalance: 1n
    });
    const { kernel } = createBaseUsdcKernel(client, {
      BLOOM_ALLOW_TRANSFER: true,
      BLOOM_ALLOW_TRANSFER_AGENT_IDS: ["agent_ej"],
      BLOOM_ALLOW_TRANSFER_TO: ["0x1111111111111111111111111111111111111111"]
    });
    const { user_id, agent_id } = kernel.createAgent({ agentId: "agent_ej" });

    const allowedQuote = await kernel.canDo({
      user_id,
      agent_id,
      intent_json: {
        type: "base_usdc_send",
        to_address: "0x1111111111111111111111111111111111111111",
        amount_cents: 100
      }
    });
    expect(allowedQuote.allowed).toBe(true);

    const deniedQuote = await kernel.canDo({
      user_id,
      agent_id,
      intent_json: {
        type: "send_usdc",
        to_address: "0x2222222222222222222222222222222222222222",
        amount_cents: 100
      }
    });
    expect(deniedQuote.allowed).toBe(false);
    expect(deniedQuote.reason).toBe("intent_not_allowlisted");
  });

  it("broadcasts once and records pending tx", async () => {
    const now = nowSeconds();
    const client = createFakeClient({
      latest: { number: 400n, timestamp: BigInt(now - 5) },
      balance: 500_000_000n,
      ethBalance: 1n
    });
    let broadcasts = 0;
    const walletClientFactory = () => ({
      writeContract: async () => {
        broadcasts += 1;
        return "0xabc0000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
      }
    });
    const { kernel, db } = createBaseUsdcKernel(client, allowTransferConfig, { walletClientFactory });
    const { user_id, agent_id } = kernel.createAgent({ agentId: "agent_ej" });

    const quote = await kernel.canDo({
      user_id,
      agent_id,
      intent_json: {
        type: "usdc_transfer",
        to_address: "0x1111111111111111111111111111111111111111",
        amount_cents: 1000
      }
    });
    expect(quote.allowed).toBe(true);

    const stepUpToken = await approveStepUp({ kernel, user_id, agent_id, quote_id: quote.quote_id });
    const exec = await kernel.execute({
      quote_id: quote.quote_id,
      idempotency_key: quote.idempotency_key,
      step_up_token: stepUpToken
    });
    expect(exec.status).toBe("applied");
    expect(broadcasts).toBe(1);

    const pendingRows = db
      .select()
      .from(baseUsdcPendingTxs)
      .where(eq(baseUsdcPendingTxs.agentId, agent_id))
      .all();
    expect(pendingRows.length).toBe(1);
    expect(pendingRows[0]?.txHash).toBe(
      "0xabc0000000000000000000000000000000000000000000000000000000000000"
    );

    const dedupRow = db
      .select()
      .from(baseUsdcActionDedup)
      .where(eq(baseUsdcActionDedup.agentId, agent_id))
      .get();
    expect(dedupRow).toBeTruthy();

    const receiptRows = db.select().from(receipts).where(eq(receipts.agentId, agent_id)).all();
    const envReceipt = receiptRows.find((row) => row.source === "env");
    expect(envReceipt?.whatHappened).toContain("tx_hash=0xabc");

    const exec2 = await kernel.execute({ quote_id: quote.quote_id, idempotency_key: quote.idempotency_key });
    expect(exec2.status).toBe("idempotent");
    expect(broadcasts).toBe(1);
  });

  it("blocks invalid address on can_do", async () => {
    const now = nowSeconds();
    const client = createFakeClient({
      latest: { number: 400n, timestamp: BigInt(now - 5) },
      balance: 500_000_000n,
      ethBalance: 1n
    });
    const { kernel } = createBaseUsdcKernel(client, allowTransferConfig);
    const { user_id, agent_id } = kernel.createAgent({ agentId: "agent_ej" });

    const quote = await kernel.canDo({
      user_id,
      agent_id,
      intent_json: { type: "usdc_transfer", to_address: "nope", amount_cents: 100 }
    });
    expect(quote.allowed).toBe(false);
    expect(quote.reason).toBe("invalid_to_address");
  });

  it("blocks transfer when gas balance is insufficient", async () => {
    const now = nowSeconds();
    const client = createFakeClient({
      latest: { number: 400n, timestamp: BigInt(now - 5) },
      balance: 500_000_000n,
      ethBalance: 0n
    });
    const { kernel } = createBaseUsdcKernel(client, allowTransferConfig);
    const { user_id, agent_id } = kernel.createAgent({ agentId: "agent_ej" });

    const quote = await kernel.canDo({
      user_id,
      agent_id,
      intent_json: {
        type: "usdc_transfer",
        to_address: "0x1111111111111111111111111111111111111111",
        amount_cents: 100
      }
    });
    expect(quote.allowed).toBe(false);
    expect(quote.reason).toBe("insufficient_gas");
  });

  it("blocks execute if confirmed balance drops before execution", async () => {
    const now = nowSeconds();
    let balance = 500_000_000n;
    const client: FakeClient = {
      getBlock: async () => ({ number: 500n, timestamp: BigInt(now - 5) }),
      getBalance: async () => 1n,
      readContract: async () => balance
    };
    let broadcasts = 0;
    const walletClientFactory = () => ({
      writeContract: async () => {
        broadcasts += 1;
        return "0xdef0000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
      }
    });
    const { kernel } = createBaseUsdcKernel(client, allowTransferConfig, { walletClientFactory });
    const { user_id, agent_id } = kernel.createAgent({ agentId: "agent_ej" });

    const quote = await kernel.canDo({
      user_id,
      agent_id,
      intent_json: {
        type: "usdc_transfer",
        to_address: "0x1111111111111111111111111111111111111111",
        amount_cents: 6000
      }
    });
    expect(quote.allowed).toBe(true);

    balance = 10_000_000n;
    const stepUpToken = await approveStepUp({ kernel, user_id, agent_id, quote_id: quote.quote_id });
    const res = await kernel.execute({
      quote_id: quote.quote_id,
      idempotency_key: quote.idempotency_key,
      step_up_token: stepUpToken
    });
    expect(res.status).toBe("rejected");
    expect(res.reason).toBe("insufficient_confirmed_usdc");
    expect(broadcasts).toBe(0);
  });
});
