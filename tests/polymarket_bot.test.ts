import { describe, expect, it, vi } from "vitest";
import { createTestContext } from "./helpers.js";
import { receipts, polymarketOrders } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { PolymarketBot } from "../src/bots/polymarket_bot.js";

describe("polymarket observe-only bot", () => {
  it("starts, stops, and emits a single observe-only receipt", async () => {
    const { db, sqlite, config, kernel } = createTestContext({ POLY_BOT_LOOP_SECONDS: 1 });
    const { agent_id } = kernel.createAgent({ agentId: "agent_ej" });

    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { slug: "market_b", volumeNum: 1000, liquidityNum: 20, clobTokenIds: ["token_b_yes"] },
        { slug: "market_c", volumeNum: 500, liquidityNum: 100, clobTokenIds: ["token_c_yes"] },
        { slug: "market_a", volumeNum: 200, liquidityNum: 50, clobTokenIds: ["token_a_yes"] }
      ]
    } as Response);

    const bot = new PolymarketBot(db, sqlite, config, { fetcher });
    const status = await bot.start(agent_id);
    expect(status.running).toBe(true);
    expect(status.agent_id).toBe(agent_id);

    bot.stop();
    const stopped = bot.status();
    expect(stopped.running).toBe(false);

    const receiptRows = db.select().from(receipts).where(eq(receipts.agentId, agent_id)).all();
    expect(receiptRows.some((row) => row.whyChanged === "observe_only")).toBe(true);
    const tick = receiptRows.find((row) => row.whyChanged === "observe_only");
    expect(tick?.whatHappened).toContain("scanned=3");
    expect(tick?.whatHappened).toContain("market_b");

    const orders = db.select().from(polymarketOrders).where(eq(polymarketOrders.agentId, agent_id)).all();
    expect(orders.length).toBe(0);
  });
});
