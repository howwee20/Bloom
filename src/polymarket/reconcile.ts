import { and, eq } from "drizzle-orm";
import type Database from "better-sqlite3";
import type { DbClient } from "../db/database.js";
import { agents, cardHolds, polymarketOrders } from "../db/schema.js";
import type { Config } from "../config.js";
import { appendEvent } from "../kernel/events.js";
import { createReceipt } from "../kernel/receipts.js";
import { nowSeconds } from "../kernel/utils.js";
import { refreshAgentSpendSnapshot } from "../kernel/spend_snapshot.js";
import {
  createClobClient,
  normalizeOrderStatus,
  parseNumeric,
  type PolymarketClobClient
} from "./clob.js";

export type PolymarketReconcileResult = {
  processed: number;
  filled: number;
  canceled: number;
  expired: number;
  skipped: number;
  pending: number;
};

type ClobClientFactory = (config: Config) => Promise<PolymarketClobClient>;

type PolymarketOrderRow = typeof polymarketOrders.$inferSelect;

type ClobOrder = {
  orderID?: string;
  orderId?: string;
  status?: string;
  original_size?: string | number;
  size_matched?: string | number;
  sizeMatched?: string | number;
};

function resolveTerminalStatus(order: ClobOrder): "filled" | "canceled" | "expired" | null {
  const status = normalizeOrderStatus(order.status);
  if (status === "canceled" || status === "cancelled") return "canceled";
  if (status === "expired") return "expired";
  if (status === "filled" || status === "matched") return "filled";
  if (status === "open" || status === "partial" || status === "partially_filled") return null;

  const matched = parseNumeric(order.size_matched ?? order.sizeMatched ?? null);
  const original = parseNumeric(order.original_size ?? null);
  if (matched !== null && original !== null && matched >= original) return "filled";
  return null;
}

function buildTerminalEvent(status: "filled" | "canceled" | "expired") {
  switch (status) {
    case "filled":
      return { eventType: "polymarket_order_filled", receipt: "Order filled.", reason: "filled" } as const;
    case "expired":
      return { eventType: "polymarket_order_expired", receipt: "Order expired.", reason: "expired" } as const;
    case "canceled":
      return { eventType: "polymarket_order_canceled", receipt: "Order canceled.", reason: "canceled" } as const;
  }
}

export async function reconcilePolymarketOrders(input: {
  db: DbClient;
  sqlite: Database;
  config: Config;
  clientFactory?: ClobClientFactory;
}): Promise<PolymarketReconcileResult> {
  if (input.config.POLY_MODE !== "real") {
    return { processed: 0, filled: 0, canceled: 0, expired: 0, skipped: 0, pending: 0 };
  }

  const openOrders = input.db
    .select()
    .from(polymarketOrders)
    .where(eq(polymarketOrders.status, "open"))
    .all();

  if (openOrders.length === 0) {
    return { processed: 0, filled: 0, canceled: 0, expired: 0, skipped: 0, pending: 0 };
  }

  const client = await (input.clientFactory ?? createClobClient)(input.config);

  let filled = 0;
  let canceled = 0;
  let expired = 0;
  let skipped = 0;
  let pending = 0;

  for (const order of openOrders) {
    let remote: ClobOrder | null = null;
    try {
      remote = (await client.getOrder(order.orderId)) as ClobOrder;
    } catch {
      skipped += 1;
      continue;
    }

    if (!remote) {
      skipped += 1;
      continue;
    }

    const terminalStatus = resolveTerminalStatus(remote);
    if (!terminalStatus) {
      pending += 1;
      continue;
    }

    const agentRow = input.db.select().from(agents).where(eq(agents.agentId, order.agentId)).get();
    if (!agentRow) {
      skipped += 1;
      continue;
    }

    const now = nowSeconds();
    const { eventType, receipt, reason } = buildTerminalEvent(terminalStatus);

    const tx = input.sqlite.transaction(() => {
      input.db
        .update(polymarketOrders)
        .set({ status: terminalStatus, updatedAt: now })
        .where(eq(polymarketOrders.orderId, order.orderId))
        .run();

      input.db
        .update(cardHolds)
        .set({ status: "released", updatedAt: now })
        .where(and(eq(cardHolds.authId, order.orderId), eq(cardHolds.agentId, order.agentId), eq(cardHolds.status, "pending")))
        .run();

      refreshAgentSpendSnapshot({
        db: input.db,
        sqlite: input.sqlite,
        config: input.config,
        agentId: order.agentId
      });

      const event = appendEvent(input.db, input.sqlite, {
        agentId: order.agentId,
        userId: agentRow.userId,
        type: eventType,
        payload: {
          order_id: order.orderId,
          market_slug: order.marketSlug,
          token_id: order.tokenId,
          status: terminalStatus,
          cost_cents: order.costCents
        }
      });

      createReceipt(input.db, {
        agentId: order.agentId,
        userId: agentRow.userId,
        source: "execution",
        eventId: event.event_id,
        externalRef: order.orderId,
        whatHappened: receipt,
        whyChanged: reason,
        whatHappensNext: "Hold released."
      });

      const holdEvent = appendEvent(input.db, input.sqlite, {
        agentId: order.agentId,
        userId: agentRow.userId,
        type: "polymarket_hold_released",
        payload: { order_id: order.orderId, amount_cents: order.costCents }
      });
      createReceipt(input.db, {
        agentId: order.agentId,
        userId: agentRow.userId,
        source: "execution",
        eventId: holdEvent.event_id,
        externalRef: order.orderId,
        whatHappened: `Hold released. amount_cents=${order.costCents}`,
        whyChanged: "hold_released",
        whatHappensNext: "Capital is available for new orders."
      });
    });

    tx();

    if (terminalStatus === "filled") filled += 1;
    if (terminalStatus === "canceled") canceled += 1;
    if (terminalStatus === "expired") expired += 1;
  }

  return {
    processed: openOrders.length,
    filled,
    canceled,
    expired,
    skipped,
    pending
  };
}
