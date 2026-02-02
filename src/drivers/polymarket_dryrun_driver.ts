import type Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import type { DbClient } from "../db/database.js";
import { cardHolds, executions, polymarketOrders } from "../db/schema.js";
import type { Config } from "../config.js";
import { appendEvent } from "../kernel/events.js";
import { createReceipt } from "../kernel/receipts.js";
import { newId, nowSeconds } from "../kernel/utils.js";
import { refreshAgentSpendSnapshot } from "../kernel/spend_snapshot.js";
import type {
  DriverBudgetContext,
  DriverDecision,
  DriverExecuteContext,
  DriverExecuteResponse,
  DriverNormalizeResult,
  DriverPreConstraintsContext,
  IntentDriver
} from "./intent_driver.js";

function normalizePlaceIntent(intent: Record<string, unknown>) {
  const marketSlug = String(intent.market_slug ?? "").trim();
  if (!marketSlug) return { ok: false as const, reason: "invalid_market_slug" };
  const tokenId = String(intent.token_id ?? "").trim();
  if (!tokenId) return { ok: false as const, reason: "invalid_token_id" };
  const sideRaw = String(intent.side ?? "").trim().toUpperCase();
  if (!sideRaw) return { ok: false as const, reason: "invalid_side" };
  if (sideRaw !== "BUY") return { ok: false as const, reason: "unsupported_intent" };
  const price = toFiniteNumber(intent.price);
  if (price === null || price <= 0 || price > 1) return { ok: false as const, reason: "invalid_price" };
  const size = toFiniteNumber(intent.size);
  if (size === null || size <= 0) return { ok: false as const, reason: "invalid_size" };
  const clientOrderIdRaw = intent.client_order_id;
  const clientOrderId =
    clientOrderIdRaw === undefined || clientOrderIdRaw === null ? null : String(clientOrderIdRaw).trim();
  if (clientOrderId !== null && clientOrderId.length === 0) {
    return { ok: false as const, reason: "invalid_client_order_id" };
  }
  const costCents = Math.ceil(price * size * 100);
  if (!Number.isFinite(costCents) || !Number.isSafeInteger(costCents) || costCents <= 0) {
    return { ok: false as const, reason: "invalid_cost" };
  }
  return {
    ok: true as const,
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

function normalizeCancelIntent(intent: Record<string, unknown>) {
  const orderId = String(intent.order_id ?? "").trim();
  if (!orderId) return { ok: false as const, reason: "invalid_order_id" };
  return {
    ok: true as const,
    intent: {
      type: "polymarket_cancel_order",
      order_id: orderId
    } as Record<string, unknown>
  };
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isAllowlisted(config: Config, agentId: string) {
  if (!config.BLOOM_ALLOW_POLYMARKET) return false;
  const allowedAgents = config.BLOOM_ALLOW_POLYMARKET_AGENT_IDS;
  if (allowedAgents.length === 0) return false;
  return allowedAgents.includes(agentId);
}

function findOrderByClientId(db: DbClient, agentId: string, clientOrderId: string) {
  return db
    .select()
    .from(polymarketOrders)
    .where(and(eq(polymarketOrders.agentId, agentId), eq(polymarketOrders.clientOrderId, clientOrderId)))
    .get() as typeof polymarketOrders.$inferSelect | undefined;
}

function getOpenOrderCount(sqlite: Database, agentId: string) {
  const row = sqlite
    .prepare("SELECT COUNT(1) as total FROM polymarket_orders WHERE agent_id = ? AND status = 'open'")
    .get(agentId) as { total?: number } | undefined;
  return row?.total ?? 0;
}

function getOpenHoldsCents(sqlite: Database, agentId: string) {
  const row = sqlite
    .prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) as total FROM card_holds WHERE agent_id = ? AND status = 'pending' AND source = 'polymarket'"
    )
    .get(agentId) as { total?: number } | undefined;
  return row?.total ?? 0;
}

export class PolymarketDryrunDriver implements IntentDriver {

  supports(intentType: string): boolean {
    return intentType === "polymarket_place_order" || intentType === "polymarket_cancel_order";
  }

  normalizeIntent(intent: Record<string, unknown>): DriverNormalizeResult {
    const type = String(intent.type ?? "");
    if (type === "polymarket_place_order") {
      const normalized = normalizePlaceIntent(intent);
      if (!normalized.ok) return { ok: false, reason: normalized.reason };
      return { ok: true, intent: normalized.intent };
    }
    if (type === "polymarket_cancel_order") {
      const normalized = normalizeCancelIntent(intent);
      if (!normalized.ok) return { ok: false, reason: normalized.reason };
      return { ok: true, intent: normalized.intent };
    }
    return { ok: false, reason: "unsupported_intent" };
  }

  getIntentCost(intent: Record<string, unknown>) {
    const type = String(intent.type ?? "");
    if (type === "polymarket_place_order" || type === "polymarket_cancel_order") {
      return { baseCost: 0, transferAmount: 0 };
    }
    return null;
  }

  preConstraints(ctx: DriverPreConstraintsContext): DriverDecision {
    if (!isAllowlisted(ctx.config, ctx.agentId)) {
      return { allowed: false, reason: "intent_not_allowlisted" };
    }

    if (ctx.intentType === "polymarket_place_order") {
      const normalized = normalizePlaceIntent(ctx.intent);
      if (!normalized.ok) return { allowed: false, reason: normalized.reason };

      const { clientOrderId, costCents } = normalized;
      if (clientOrderId) {
        const existing = findOrderByClientId(ctx.db, ctx.agentId, clientOrderId);
        if (existing) {
          return { allowed: true, reason: "ok", requires_step_up: false };
        }
      }

      if (costCents > ctx.config.POLY_DRYRUN_MAX_PER_ORDER_CENTS) {
        return { allowed: false, reason: "order_cost_exceeds_max" };
      }
      const openOrders = getOpenOrderCount(ctx.sqlite, ctx.agentId);
      if (openOrders >= ctx.config.POLY_DRYRUN_MAX_OPEN_ORDERS) {
        return { allowed: false, reason: "open_orders_limit_reached" };
      }
      const openHolds = getOpenHoldsCents(ctx.sqlite, ctx.agentId);
      if (openHolds + costCents > ctx.config.POLY_DRYRUN_MAX_OPEN_HOLDS_CENTS) {
        return { allowed: false, reason: "open_holds_limit_exceeded" };
      }
      return { allowed: true, reason: "ok", requires_step_up: false };
    }

    if (ctx.intentType === "polymarket_cancel_order") {
      const normalized = normalizeCancelIntent(ctx.intent);
      if (!normalized.ok) return { allowed: false, reason: normalized.reason };
      const orderId = String((normalized.intent as { order_id?: string }).order_id ?? "");
      const existingOrder = ctx.db
        .select()
        .from(polymarketOrders)
        .where(and(eq(polymarketOrders.orderId, orderId), eq(polymarketOrders.agentId, ctx.agentId)))
        .get() as typeof polymarketOrders.$inferSelect | undefined;
      if (!existingOrder) {
        return { allowed: false, reason: "order_not_found" };
      }
      return { allowed: true, reason: "ok", requires_step_up: false };
    }

    return { allowed: false, reason: "unsupported_intent" };
  }

  postBudgetConstraints(ctx: DriverBudgetContext): DriverDecision {
    if (ctx.intentType !== "polymarket_place_order") {
      return { allowed: true, reason: "ok", requires_step_up: false };
    }

    const normalized = normalizePlaceIntent(ctx.intent);
    if (!normalized.ok) return { allowed: false, reason: normalized.reason };

    const { clientOrderId, costCents } = normalized;
    if (clientOrderId) {
      const existing = findOrderByClientId(ctx.db, ctx.agentId, clientOrderId);
      if (existing) {
        return { allowed: true, reason: "ok", requires_step_up: false };
      }
    }

    const spendPower = Math.max(0, ctx.policySpendableCents - ctx.reservedHoldsCents);
    if (costCents > spendPower) {
      return {
        allowed: false,
        reason: "insufficient_spend_power",
        spend_power: {
          policy_spendable_cents: ctx.policySpendableCents,
          effective_spend_power_cents: spendPower
        },
        facts_snapshot: ctx.factsSnapshotBase
      };
    }

    return { allowed: true, reason: "ok", requires_step_up: false };
  }

  execute(ctx: DriverExecuteContext): DriverExecuteResponse {
    const intentType = String(ctx.intent.type ?? "");
    if (intentType === "polymarket_place_order") {
      return this.executePlace(ctx);
    }
    if (intentType === "polymarket_cancel_order") {
      return this.executeCancel(ctx);
    }
    return { status: "rejected", reason: "unsupported_intent" };
  }

  private executePlace(ctx: DriverExecuteContext): DriverExecuteResponse {
    const normalized = normalizePlaceIntent(ctx.intent);
    if (!normalized.ok) {
      const event = appendEvent(ctx.db, ctx.sqlite, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        type: "execution_rejected",
        payload: { reason: normalized.reason, quote_id: ctx.quote.quoteId }
      });
      createReceipt(ctx.db, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        source: "policy",
        eventId: event.event_id,
        externalRef: ctx.quote.quoteId,
        whatHappened: "Execution rejected: invalid intent.",
        whyChanged: normalized.reason,
        whatHappensNext: "Request a new quote."
      });
      return { status: "rejected", reason: normalized.reason };
    }

    const { intent, clientOrderId, costCents } = normalized;
    if (clientOrderId) {
      const existingOrder = findOrderByClientId(ctx.db, ctx.quote.agentId, clientOrderId);
      if (existingOrder) {
        const execId = newId("exec");
        const now = nowSeconds();
        const tx = ctx.sqlite.transaction(() => {
          ctx.db.insert(executions).values({
            execId,
            quoteId: ctx.quote.quoteId,
            userId: ctx.quote.userId,
            agentId: ctx.quote.agentId,
            status: "applied",
            externalRef: existingOrder.orderId,
            createdAt: now,
            updatedAt: now
          }).run();

          const event = appendEvent(ctx.db, ctx.sqlite, {
            agentId: ctx.quote.agentId,
            userId: ctx.quote.userId,
            type: "polymarket_order_idempotent",
            payload: { order_id: existingOrder.orderId, client_order_id: clientOrderId }
          });
          createReceipt(ctx.db, {
            agentId: ctx.quote.agentId,
            userId: ctx.quote.userId,
            source: "execution",
            eventId: event.event_id,
            externalRef: existingOrder.orderId,
            whatHappened: "Dry-run order already exists.",
            whyChanged: "idempotent_replay",
            whatHappensNext: "No new hold created."
          });
        });
        tx();
        return { status: "idempotent", exec_id: execId, external_ref: existingOrder.orderId };
      }
    }

    const orderId = newId("poly_order");
    const holdId = orderId;
    const execId = newId("exec");
    const now = nowSeconds();

    const tx = ctx.sqlite.transaction(() => {
      ctx.db.insert(executions).values({
        execId,
        quoteId: ctx.quote.quoteId,
        userId: ctx.quote.userId,
        agentId: ctx.quote.agentId,
        status: "applied",
        externalRef: orderId,
        createdAt: now,
        updatedAt: now
      }).run();

      ctx.db.insert(polymarketOrders).values({
        orderId,
        agentId: ctx.quote.agentId,
        marketSlug: String(intent.market_slug),
        tokenId: String(intent.token_id),
        side: "BUY",
        price: Number(intent.price),
        size: Number(intent.size),
        costCents,
        status: "open",
        clientOrderId,
        createdAt: now,
        updatedAt: now
      }).run();

      ctx.db.insert(cardHolds).values({
        authId: holdId,
        agentId: ctx.quote.agentId,
        amountCents: costCents,
        status: "pending",
        source: "polymarket",
        createdAt: now,
        updatedAt: now
      }).run();

      const orderEvent = appendEvent(ctx.db, ctx.sqlite, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        type: "polymarket_order_opened",
        payload: {
          order_id: orderId,
          market_slug: intent.market_slug,
          token_id: intent.token_id,
          side: intent.side,
          price: intent.price,
          size: intent.size,
          cost_cents: costCents,
          client_order_id: clientOrderId
        }
      });
      createReceipt(ctx.db, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        source: "execution",
        eventId: orderEvent.event_id,
        externalRef: orderId,
        whatHappened: "Dry-run order opened.",
        whyChanged: "dryrun_open",
        whatHappensNext: "Order is open (dry-run)."
      });

      const holdEvent = appendEvent(ctx.db, ctx.sqlite, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        type: "polymarket_hold_created",
        payload: { order_id: orderId, hold_id: holdId, amount_cents: costCents }
      });
      createReceipt(ctx.db, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        source: "execution",
        eventId: holdEvent.event_id,
        externalRef: orderId,
        whatHappened: "Hold created.",
        whyChanged: "hold_created",
        whatHappensNext: "Capital is reserved until cancel."
      });

      const execEvent = appendEvent(ctx.db, ctx.sqlite, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        type: "execution_applied",
        payload: { quote_id: ctx.quote.quoteId, exec_id: execId, external_ref: orderId }
      });
      createReceipt(ctx.db, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        source: "execution",
        eventId: execEvent.event_id,
        externalRef: orderId,
        whatHappened: "Execution applied.",
        whyChanged: "applied",
        whatHappensNext: "Order remains open (dry-run)."
      });
    });

    try {
      tx();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "execution_error";
      const event = appendEvent(ctx.db, ctx.sqlite, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        type: "execution_failed",
        payload: { reason, quote_id: ctx.quote.quoteId }
      });
      createReceipt(ctx.db, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        source: "execution",
        eventId: event.event_id,
        externalRef: ctx.quote.quoteId,
        whatHappened: "Execution failed before apply.",
        whyChanged: reason,
        whatHappensNext: "Review constraints and retry."
      });
      return { status: "failed", reason };
    }

    refreshAgentSpendSnapshot({
      db: ctx.db,
      sqlite: ctx.sqlite,
      config: ctx.config,
      agentId: ctx.quote.agentId
    });

    return { status: "applied", exec_id: execId, external_ref: orderId };
  }

  private executeCancel(ctx: DriverExecuteContext): DriverExecuteResponse {
    const normalized = normalizeCancelIntent(ctx.intent);
    if (!normalized.ok) {
      const event = appendEvent(ctx.db, ctx.sqlite, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        type: "execution_rejected",
        payload: { reason: normalized.reason, quote_id: ctx.quote.quoteId }
      });
      createReceipt(ctx.db, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        source: "policy",
        eventId: event.event_id,
        externalRef: ctx.quote.quoteId,
        whatHappened: "Execution rejected: invalid intent.",
        whyChanged: normalized.reason,
        whatHappensNext: "Request a new quote."
      });
      return { status: "rejected", reason: normalized.reason };
    }

    const orderId = String((normalized.intent as { order_id?: string }).order_id ?? "");
    const existingOrder = ctx.db
      .select()
      .from(polymarketOrders)
      .where(and(eq(polymarketOrders.orderId, orderId), eq(polymarketOrders.agentId, ctx.quote.agentId)))
      .get() as typeof polymarketOrders.$inferSelect | undefined;
    if (!existingOrder) {
      const event = appendEvent(ctx.db, ctx.sqlite, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        type: "execution_rejected",
        payload: { reason: "order_not_found", quote_id: ctx.quote.quoteId, order_id: orderId }
      });
      createReceipt(ctx.db, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        source: "policy",
        eventId: event.event_id,
        externalRef: orderId,
        whatHappened: "Execution rejected: order not found.",
        whyChanged: "order_not_found",
        whatHappensNext: "Provide a valid order id."
      });
      return { status: "rejected", reason: "order_not_found" };
    }

    const now = nowSeconds();
    const execId = newId("exec");
    if (existingOrder.status === "canceled") {
      const tx = ctx.sqlite.transaction(() => {
        ctx.db.insert(executions).values({
          execId,
          quoteId: ctx.quote.quoteId,
          userId: ctx.quote.userId,
          agentId: ctx.quote.agentId,
          status: "applied",
          externalRef: orderId,
          createdAt: now,
          updatedAt: now
        }).run();

        const event = appendEvent(ctx.db, ctx.sqlite, {
          agentId: ctx.quote.agentId,
          userId: ctx.quote.userId,
          type: "polymarket_order_already_canceled",
          payload: { order_id: orderId }
        });
        createReceipt(ctx.db, {
          agentId: ctx.quote.agentId,
          userId: ctx.quote.userId,
          source: "execution",
          eventId: event.event_id,
          externalRef: orderId,
          whatHappened: "Dry-run order already canceled.",
          whyChanged: "idempotent_replay",
          whatHappensNext: "No action required."
        });
      });
      tx();
      return { status: "idempotent", exec_id: execId, external_ref: orderId };
    }

    const tx = ctx.sqlite.transaction(() => {
      ctx.db.insert(executions).values({
        execId,
        quoteId: ctx.quote.quoteId,
        userId: ctx.quote.userId,
        agentId: ctx.quote.agentId,
        status: "applied",
        externalRef: orderId,
        createdAt: now,
        updatedAt: now
      }).run();

      ctx.db
        .update(polymarketOrders)
        .set({ status: "canceled", updatedAt: now })
        .where(eq(polymarketOrders.orderId, orderId))
        .run();

      ctx.db
        .update(cardHolds)
        .set({ status: "released", updatedAt: now })
        .where(and(eq(cardHolds.authId, orderId), eq(cardHolds.agentId, ctx.quote.agentId), eq(cardHolds.status, "pending")))
        .run();

      const orderEvent = appendEvent(ctx.db, ctx.sqlite, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        type: "polymarket_order_canceled",
        payload: { order_id: orderId }
      });
      createReceipt(ctx.db, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        source: "execution",
        eventId: orderEvent.event_id,
        externalRef: orderId,
        whatHappened: "Dry-run order canceled.",
        whyChanged: "dryrun_canceled",
        whatHappensNext: "Order is closed (dry-run)."
      });

      const holdEvent = appendEvent(ctx.db, ctx.sqlite, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        type: "polymarket_hold_released",
        payload: { order_id: orderId, amount_cents: existingOrder.costCents }
      });
      createReceipt(ctx.db, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        source: "execution",
        eventId: holdEvent.event_id,
        externalRef: orderId,
        whatHappened: "Hold released.",
        whyChanged: "hold_released",
        whatHappensNext: "Capital is available for new orders."
      });

      const execEvent = appendEvent(ctx.db, ctx.sqlite, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        type: "execution_applied",
        payload: { quote_id: ctx.quote.quoteId, exec_id: execId, external_ref: orderId }
      });
      createReceipt(ctx.db, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        source: "execution",
        eventId: execEvent.event_id,
        externalRef: orderId,
        whatHappened: "Execution applied.",
        whyChanged: "applied",
        whatHappensNext: "Order canceled and hold released."
      });
    });

    try {
      tx();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "execution_error";
      const event = appendEvent(ctx.db, ctx.sqlite, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        type: "execution_failed",
        payload: { reason, quote_id: ctx.quote.quoteId }
      });
      createReceipt(ctx.db, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        source: "execution",
        eventId: event.event_id,
        externalRef: ctx.quote.quoteId,
        whatHappened: "Execution failed before apply.",
        whyChanged: reason,
        whatHappensNext: "Review constraints and retry."
      });
      return { status: "failed", reason };
    }

    refreshAgentSpendSnapshot({
      db: ctx.db,
      sqlite: ctx.sqlite,
      config: ctx.config,
      agentId: ctx.quote.agentId
    });

    return { status: "applied", exec_id: execId, external_ref: orderId };
  }
}
