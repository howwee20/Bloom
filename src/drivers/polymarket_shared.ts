import type Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import type { DbClient } from "../db/database.js";
import { cardHolds, polymarketOrders } from "../db/schema.js";
import type { Config } from "../config.js";

export type NormalizedPlaceIntent = {
  ok: true;
  costCents: number;
  clientOrderId: string | null;
  intent: Record<string, unknown>;
};

export type NormalizedCancelIntent = {
  ok: true;
  intent: Record<string, unknown>;
};

export type NormalizedIntentResult =
  | (NormalizedPlaceIntent & { ok: true })
  | (NormalizedCancelIntent & { ok: true })
  | { ok: false; reason: string };

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function normalizePlaceIntent(intent: Record<string, unknown>):
  | NormalizedPlaceIntent
  | { ok: false; reason: string } {
  const marketSlug = String(intent.market_slug ?? "").trim();
  if (!marketSlug) return { ok: false, reason: "invalid_market_slug" };
  const tokenId = String(intent.token_id ?? "").trim();
  if (!tokenId) return { ok: false, reason: "invalid_token_id" };
  const sideRaw = String(intent.side ?? "").trim().toUpperCase();
  if (!sideRaw) return { ok: false, reason: "invalid_side" };
  if (sideRaw !== "BUY") return { ok: false, reason: "unsupported_intent" };
  const price = toFiniteNumber(intent.price);
  if (price === null || price <= 0 || price > 1) return { ok: false, reason: "invalid_price" };
  const size = toFiniteNumber(intent.size);
  if (size === null || size <= 0) return { ok: false, reason: "invalid_size" };
  const clientOrderIdRaw = intent.client_order_id;
  const clientOrderId =
    clientOrderIdRaw === undefined || clientOrderIdRaw === null ? null : String(clientOrderIdRaw).trim();
  if (clientOrderId !== null && clientOrderId.length === 0) {
    return { ok: false, reason: "invalid_client_order_id" };
  }
  const costCents = Math.ceil(price * size * 100);
  if (!Number.isFinite(costCents) || !Number.isSafeInteger(costCents) || costCents <= 0) {
    return { ok: false, reason: "invalid_cost" };
  }
  return {
    ok: true,
    costCents,
    clientOrderId,
    intent: {
      type: "polymarket_place_order",
      market_slug: marketSlug,
      token_id: tokenId,
      side: "BUY",
      price,
      size,
      ...(clientOrderId ? { client_order_id: clientOrderId } : {})
    } as Record<string, unknown>
  };
}

export function normalizeCancelIntent(intent: Record<string, unknown>):
  | NormalizedCancelIntent
  | { ok: false; reason: string } {
  const orderId = String(intent.order_id ?? "").trim();
  if (!orderId) return { ok: false, reason: "invalid_order_id" };
  return {
    ok: true,
    intent: {
      type: "polymarket_cancel_order",
      order_id: orderId
    } as Record<string, unknown>
  };
}

export function isAllowlisted(config: Config, agentId: string) {
  if (!config.BLOOM_ALLOW_POLYMARKET) return false;
  const allowedAgents = config.BLOOM_ALLOW_POLYMARKET_AGENT_IDS;
  if (allowedAgents.length === 0) return false;
  return allowedAgents.includes(agentId);
}

export function findOrderByClientId(db: DbClient, agentId: string, clientOrderId: string) {
  return db
    .select()
    .from(polymarketOrders)
    .where(and(eq(polymarketOrders.agentId, agentId), eq(polymarketOrders.clientOrderId, clientOrderId)))
    .get() as typeof polymarketOrders.$inferSelect | undefined;
}

export function getOpenOrderCount(sqlite: Database, agentId: string) {
  const row = sqlite
    .prepare("SELECT COUNT(1) as total FROM polymarket_orders WHERE agent_id = ? AND status = 'open'")
    .get(agentId) as { total?: number } | undefined;
  return row?.total ?? 0;
}

export function getOpenHoldsCents(sqlite: Database, agentId: string) {
  const row = sqlite
    .prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) as total FROM card_holds WHERE agent_id = ? AND status = 'pending' AND source = 'polymarket'"
    )
    .get(agentId) as { total?: number } | undefined;
  return row?.total ?? 0;
}

/**
 * Get the total Polymarket spend (in cents) for an agent today (UTC).
 * Includes both pending and settled holds created since UTC midnight.
 */
export function getPolymarketSpendTodayCents(sqlite: Database, agentId: string): number {
  const now = new Date();
  const utcMidnight = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);

  const row = sqlite
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) as total FROM card_holds
       WHERE agent_id = ? AND source = 'polymarket'
       AND (status = 'pending' OR status = 'settled')
       AND created_at >= ?`
    )
    .get(agentId, utcMidnight) as { total?: number } | undefined;
  return row?.total ?? 0;
}

export function getHoldAmountCents(sqlite: Database, agentId: string, orderId: string) {
  const row = sqlite
    .prepare("SELECT amount_cents as amount FROM card_holds WHERE agent_id = ? AND auth_id = ?")
    .get(agentId, orderId) as { amount?: number } | undefined;
  return row?.amount ?? null;
}

export function updateHoldReleased(
  db: DbClient,
  agentId: string,
  orderId: string,
  updatedAt: number
) {
  db
    .update(cardHolds)
    .set({ status: "released", updatedAt })
    .where(and(eq(cardHolds.authId, orderId), eq(cardHolds.agentId, agentId), eq(cardHolds.status, "pending")))
    .run();
}
