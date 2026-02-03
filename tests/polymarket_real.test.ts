import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/db/database.js";
import { applyMigrations } from "./helpers.js";
import { SimpleEconomyWorld } from "../src/env/simple_economy.js";
import { Kernel } from "../src/kernel/kernel.js";
import { PolymarketRealDriver } from "../src/drivers/polymarket_real_driver.js";
import { reconcilePolymarketOrders } from "../src/polymarket/reconcile.js";
import { cardHolds, polymarketOrders } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import type { Config } from "../src/config.js";

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
    BLOOM_ALLOW_POLYMARKET: true,
    BLOOM_ALLOW_POLYMARKET_AGENT_IDS: ["agent_ej"],
    POLY_DRYRUN_MAX_PER_ORDER_CENTS: 500,
    POLY_DRYRUN_MAX_OPEN_HOLDS_CENTS: 2000,
    POLY_DRYRUN_MAX_OPEN_ORDERS: 20,
    POLY_DRYRUN_LOOP_SECONDS: 30,
    POLY_MODE: "real",
    POLY_CLOB_HOST: "https://clob.polymarket.com",
    POLY_GAMMA_HOST: "https://gamma-api.polymarket.com",
    POLY_DATA_HOST: "https://data-api.polymarket.com",
    POLY_CHAIN_ID: 137,
    POLY_PRIVATE_KEY: "0x" + "1".repeat(64),
    POLY_API_KEY: null,
    POLY_API_SECRET: null,
    POLY_API_PASSPHRASE: null,
    POLY_BOT_AGENT_ID: "agent_ej",
    POLY_BOT_LOOP_SECONDS: 60,
    POLY_BOT_TRADING_ENABLED: false,
    ...overrides
  };
}

describe("polymarket real driver", () => {
  it("places and cancels real orders with holds", async () => {
    const { sqlite, db } = createDatabase(":memory:");
    applyMigrations(sqlite);
    const config = makeConfig();
    const env = new SimpleEconomyWorld(db, sqlite, config);

    const mockClient = {
      createAndPostOrder: vi.fn().mockResolvedValue({ orderID: "order_1" }),
      cancelOrder: vi.fn().mockResolvedValue({ ok: true }),
      getOrder: vi.fn().mockResolvedValue({ status: "open" }),
      getOpenOrders: vi.fn().mockResolvedValue([])
    };

    const driver = new PolymarketRealDriver({ clientFactory: async () => mockClient });
    const kernel = new Kernel(db, sqlite, env, config, [driver]);

    const { user_id, agent_id } = kernel.createAgent({ agentId: "agent_ej" });

    const quote = await kernel.canDo({
      user_id,
      agent_id,
      intent_json: {
        type: "polymarket_place_order",
        market_slug: "test_market",
        token_id: "YES_123",
        side: "BUY",
        price: 0.42,
        size: 10,
        client_order_id: "client_1"
      }
    });
    expect(quote.allowed).toBe(true);

    const exec = await kernel.execute({ quote_id: quote.quote_id, idempotency_key: quote.idempotency_key });
    expect(exec.status).toBe("applied");
    expect(exec.external_ref).toBe("order_1");

    const order = db.select().from(polymarketOrders).where(eq(polymarketOrders.orderId, "order_1")).get();
    expect(order?.status).toBe("open");
    const hold = db.select().from(cardHolds).where(eq(cardHolds.authId, "order_1")).get();
    expect(hold?.status).toBe("pending");

    const cancelQuote = await kernel.canDo({
      user_id,
      agent_id,
      intent_json: { type: "polymarket_cancel_order", order_id: "order_1" }
    });
    expect(cancelQuote.allowed).toBe(true);

    const cancelExec = await kernel.execute({
      quote_id: cancelQuote.quote_id,
      idempotency_key: cancelQuote.idempotency_key
    });
    expect(cancelExec.status).toBe("applied");
    expect(mockClient.cancelOrder).toHaveBeenCalledWith({ orderID: "order_1" });

    const canceledOrder = db.select().from(polymarketOrders).where(eq(polymarketOrders.orderId, "order_1")).get();
    expect(canceledOrder?.status).toBe("canceled");
    const releasedHold = db.select().from(cardHolds).where(eq(cardHolds.authId, "order_1")).get();
    expect(releasedHold?.status).toBe("released");
  });

  it("reconciles terminal orders and releases holds", async () => {
    const { sqlite, db } = createDatabase(":memory:");
    applyMigrations(sqlite);
    const config = makeConfig();
    const env = new SimpleEconomyWorld(db, sqlite, config);

    const mockClient = {
      createAndPostOrder: vi.fn(),
      cancelOrder: vi.fn(),
      getOrder: vi.fn().mockResolvedValue({ status: "filled" }),
      getOpenOrders: vi.fn().mockResolvedValue([])
    };

    const driver = new PolymarketRealDriver({ clientFactory: async () => mockClient });
    const kernel = new Kernel(db, sqlite, env, config, [driver]);
    const { agent_id } = kernel.createAgent({ agentId: "agent_ej" });

    const now = Math.floor(Date.now() / 1000);
    db.insert(polymarketOrders)
      .values({
        orderId: "order_2",
        agentId: agent_id,
        marketSlug: "test_market",
        tokenId: "YES_123",
        side: "BUY",
        price: 0.5,
        size: 10,
        costCents: 500,
        status: "open",
        clientOrderId: "client_2",
        createdAt: now,
        updatedAt: now
      })
      .run();
    db.insert(cardHolds)
      .values({
        agentId: agent_id,
        authId: "order_2",
        amountCents: 500,
        status: "pending",
        source: "polymarket",
        createdAt: now,
        updatedAt: now
      })
      .run();

    const result = await reconcilePolymarketOrders({
      db,
      sqlite,
      config,
      clientFactory: async () => mockClient
    });
    expect(result.filled).toBe(1);

    const order = db.select().from(polymarketOrders).where(eq(polymarketOrders.orderId, "order_2")).get();
    expect(order?.status).toBe("filled");
    const hold = db.select().from(cardHolds).where(eq(cardHolds.authId, "order_2")).get();
    expect(hold?.status).toBe("released");
  });
});
