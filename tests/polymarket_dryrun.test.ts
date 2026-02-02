import { describe, expect, it } from "vitest";
import { createTestContext } from "./helpers.js";
import { cardHolds, polymarketOrders, receipts } from "../src/db/schema.js";
import { and, eq } from "drizzle-orm";
import { PolymarketDryrunBot } from "../src/bots/polymarket_dryrun_bot.js";

function makePlaceIntent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: "polymarket_place_order",
    market_slug: "test_market",
    token_id: "YES_123",
    side: "BUY",
    price: 0.5,
    size: 10,
    ...overrides
  };
}

const POLY_ALLOW_CONFIG = {
  BLOOM_ALLOW_POLYMARKET: true,
  BLOOM_ALLOW_POLYMARKET_AGENT_IDS: ["agent_ej"],
  DEFAULT_DAILY_SPEND_CENTS: 100000,
  DEFAULT_CREDITS_CENTS: 100000
};

describe("polymarket dry-run driver", () => {
  it("denies by default", async () => {
    const { kernel } = createTestContext();
    const { user_id, agent_id } = kernel.createAgent({ agentId: "agent_ej" });
    const quote = await kernel.canDo({ user_id, agent_id, intent_json: makePlaceIntent() });
    expect(quote.allowed).toBe(false);
    expect(quote.reason).toBe("intent_not_allowlisted");
  });

  it("allows when env allowlist includes agent", async () => {
    const { kernel } = createTestContext(POLY_ALLOW_CONFIG);
    const { user_id, agent_id } = kernel.createAgent({ agentId: "agent_ej" });
    const quote = await kernel.canDo({ user_id, agent_id, intent_json: makePlaceIntent() });
    expect(quote.allowed).toBe(true);
    expect(quote.reason).toBe("ok");
  });

  it("enforces per-order cap and open hold limits", async () => {
    const { kernel, db } = createTestContext({
      ...POLY_ALLOW_CONFIG,
      POLY_DRYRUN_MAX_PER_ORDER_CENTS: 100,
      POLY_DRYRUN_MAX_OPEN_HOLDS_CENTS: 150,
      POLY_DRYRUN_MAX_OPEN_ORDERS: 5
    });
    const { user_id, agent_id } = kernel.createAgent({ agentId: "agent_ej" });

    const tooBig = await kernel.canDo({
      user_id,
      agent_id,
      intent_json: makePlaceIntent({ price: 1, size: 2 })
    });
    expect(tooBig.allowed).toBe(false);
    expect(tooBig.reason).toBe("order_cost_exceeds_max");

    const firstQuote = await kernel.canDo({ user_id, agent_id, intent_json: makePlaceIntent({ price: 0.8, size: 1 }) });
    expect(firstQuote.allowed).toBe(true);
    await kernel.execute({ quote_id: firstQuote.quote_id, idempotency_key: firstQuote.idempotency_key });

    const secondQuote = await kernel.canDo({ user_id, agent_id, intent_json: makePlaceIntent({ price: 0.8, size: 1 }) });
    expect(secondQuote.allowed).toBe(false);
    expect(secondQuote.reason).toBe("open_holds_limit_exceeded");

    const holds = db
      .select()
      .from(cardHolds)
      .where(and(eq(cardHolds.agentId, agent_id), eq(cardHolds.source, "polymarket")))
      .all();
    expect(holds.length).toBe(1);
  });

  it("enforces open order count limit", async () => {
    const { kernel } = createTestContext({
      ...POLY_ALLOW_CONFIG,
      POLY_DRYRUN_MAX_PER_ORDER_CENTS: 500,
      POLY_DRYRUN_MAX_OPEN_HOLDS_CENTS: 1000,
      POLY_DRYRUN_MAX_OPEN_ORDERS: 1
    });
    const { user_id, agent_id } = kernel.createAgent({ agentId: "agent_ej" });
    const firstQuote = await kernel.canDo({ user_id, agent_id, intent_json: makePlaceIntent({ price: 0.2, size: 10 }) });
    expect(firstQuote.allowed).toBe(true);
    await kernel.execute({ quote_id: firstQuote.quote_id, idempotency_key: firstQuote.idempotency_key });

    const secondQuote = await kernel.canDo({ user_id, agent_id, intent_json: makePlaceIntent({ price: 0.2, size: 10 }) });
    expect(secondQuote.allowed).toBe(false);
    expect(secondQuote.reason).toBe("open_orders_limit_reached");
  });

  it("is idempotent with client_order_id", async () => {
    const { kernel, db } = createTestContext({
      ...POLY_ALLOW_CONFIG
    });
    const { user_id, agent_id } = kernel.createAgent({ agentId: "agent_ej" });
    const intent = makePlaceIntent({ client_order_id: "client_1" });

    const firstQuote = await kernel.canDo({ user_id, agent_id, intent_json: intent });
    const firstExec = await kernel.execute({ quote_id: firstQuote.quote_id, idempotency_key: firstQuote.idempotency_key });
    expect(firstExec.status).toBe("applied");

    const secondQuote = await kernel.canDo({ user_id, agent_id, intent_json: intent });
    const secondExec = await kernel.execute({ quote_id: secondQuote.quote_id, idempotency_key: secondQuote.idempotency_key });
    expect(secondExec.status).toBe("idempotent");

    const orders = db.select().from(polymarketOrders).where(eq(polymarketOrders.agentId, agent_id)).all();
    expect(orders.length).toBe(1);
    const holds = db
      .select()
      .from(cardHolds)
      .where(and(eq(cardHolds.agentId, agent_id), eq(cardHolds.source, "polymarket")))
      .all();
    expect(holds.length).toBe(1);
  });

  it("cancels orders, releases holds, and is idempotent", async () => {
    const { kernel, db } = createTestContext({
      ...POLY_ALLOW_CONFIG
    });
    const { user_id, agent_id } = kernel.createAgent({ agentId: "agent_ej" });
    const placeQuote = await kernel.canDo({ user_id, agent_id, intent_json: makePlaceIntent({ price: 0.3, size: 10 }) });
    const placeExec = await kernel.execute({ quote_id: placeQuote.quote_id, idempotency_key: placeQuote.idempotency_key });
    const orderId = placeExec.external_ref as string;

    const cancelQuote = await kernel.canDo({
      user_id,
      agent_id,
      intent_json: { type: "polymarket_cancel_order", order_id: orderId }
    });
    const cancelExec = await kernel.execute({ quote_id: cancelQuote.quote_id, idempotency_key: cancelQuote.idempotency_key });
    expect(cancelExec.status).toBe("applied");

    const order = db.select().from(polymarketOrders).where(eq(polymarketOrders.orderId, orderId)).get();
    expect(order?.status).toBe("canceled");
    const hold = db.select().from(cardHolds).where(eq(cardHolds.authId, orderId)).get();
    expect(hold?.status).toBe("released");

    const cancelQuote2 = await kernel.canDo({
      user_id,
      agent_id,
      intent_json: { type: "polymarket_cancel_order", order_id: orderId }
    });
    const cancelExec2 = await kernel.execute({ quote_id: cancelQuote2.quote_id, idempotency_key: cancelQuote2.idempotency_key });
    expect(cancelExec2.status).toBe("idempotent");
  });

  it("bot emits observe-only receipts without trading", () => {
    const { db, sqlite, config, kernel } = createTestContext({ POLY_DRYRUN_LOOP_SECONDS: 1 });
    const { agent_id } = kernel.createAgent({ agentId: "agent_ej" });
    const bot = new PolymarketDryrunBot(db, sqlite, config);
    bot.start(agent_id);
    bot.stop();

    const receiptRows = db.select().from(receipts).where(eq(receipts.agentId, agent_id)).all();
    expect(receiptRows.some((row) => row.whyChanged === "observe_only")).toBe(true);

    const orders = db.select().from(polymarketOrders).where(eq(polymarketOrders.agentId, agent_id)).all();
    expect(orders.length).toBe(0);
  });
});
