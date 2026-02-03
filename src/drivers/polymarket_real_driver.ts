import { and, eq } from "drizzle-orm";
import { cardHolds, executions, polymarketOrders } from "../db/schema.js";
import { appendEvent } from "../kernel/events.js";
import { createReceipt } from "../kernel/receipts.js";
import { newId, nowSeconds } from "../kernel/utils.js";
import { refreshAgentSpendSnapshot } from "../kernel/spend_snapshot.js";
import {
  extractOrderId,
  createClobClient,
  OrderType,
  Side
} from "../polymarket/clob.js";
import {
  findOrderByClientId,
  getOpenHoldsCents,
  getOpenOrderCount,
  getPolymarketSpendTodayCents,
  isAllowlisted,
  normalizeCancelIntent,
  normalizePlaceIntent
} from "./polymarket_shared.js";
import type {
  DriverBudgetContext,
  DriverDecision,
  DriverExecuteContext,
  DriverExecuteResponse,
  DriverNormalizeResult,
  DriverPreConstraintsContext,
  IntentDriver
} from "./intent_driver.js";
import type { Config } from "../config.js";
import type { PolymarketClobClient } from "../polymarket/clob.js";

type ClobClientFactory = (config: Config) => Promise<PolymarketClobClient>;

function ensureRealMode(config: Config) {
  return config.POLY_MODE === "real";
}

function hasPrivateKey(config: Config) {
  return Boolean(config.POLY_PRIVATE_KEY && config.POLY_PRIVATE_KEY.trim().length > 0);
}

function orderResponseError(response: Record<string, unknown>) {
  const ok = response.success === undefined ? undefined : Boolean(response.success);
  if (ok === false) {
    return String(response.errorMsg ?? response.message ?? "order_rejected");
  }
  if (response.errorMsg || response.error) {
    return String(response.errorMsg ?? response.error ?? "order_rejected");
  }
  return null;
}

export class PolymarketRealDriver implements IntentDriver {
  private clientFactory: ClobClientFactory;

  constructor(options: { clientFactory?: ClobClientFactory } = {}) {
    this.clientFactory = options.clientFactory ?? createClobClient;
  }

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
    if (!ensureRealMode(ctx.config)) {
      return { allowed: false, reason: "polymarket_real_disabled" };
    }
    if (!hasPrivateKey(ctx.config)) {
      return { allowed: false, reason: "polymarket_private_key_missing" };
    }
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

      // Use real limits (not dryrun)
      if (costCents > ctx.config.POLY_MAX_PER_ORDER_CENTS) {
        return { allowed: false, reason: "order_cost_exceeds_max" };
      }
      const openOrders = getOpenOrderCount(ctx.sqlite, ctx.agentId);
      if (openOrders >= ctx.config.POLY_MAX_OPEN_ORDERS) {
        return { allowed: false, reason: "open_orders_limit_reached" };
      }
      const openHolds = getOpenHoldsCents(ctx.sqlite, ctx.agentId);
      if (openHolds + costCents > ctx.config.POLY_MAX_OPEN_HOLDS_CENTS) {
        return { allowed: false, reason: "open_holds_limit_exceeded" };
      }

      // Step-up requirement when trading is enabled
      // Unless auto-approve is set AND agent is in allowlist
      let requiresStepUp = false;
      if (ctx.config.POLY_BOT_TRADING_ENABLED) {
        const autoApprove = ctx.config.POLY_TRADE_AUTO_APPROVE;
        const inAutoApproveList = ctx.config.BLOOM_AUTO_APPROVE_AGENT_IDS.includes(ctx.agentId);
        requiresStepUp = !(autoApprove && inAutoApproveList);
      }

      return { allowed: true, reason: "ok", requires_step_up: requiresStepUp };
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

    // Check daily limit (real mode)
    const maxDailyCents = ctx.config.POLY_MAX_PER_DAY_CENTS;
    if (maxDailyCents > 0) {
      const spendTodayCents = getPolymarketSpendTodayCents(ctx.sqlite, ctx.agentId);
      if (spendTodayCents + costCents > maxDailyCents) {
        return {
          allowed: false,
          reason: "daily_limit_reached",
          spend_power: {
            spend_today_cents: spendTodayCents,
            trade_cost_cents: costCents,
            max_daily_cents: maxDailyCents
          },
          facts_snapshot: ctx.factsSnapshotBase
        };
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

  async execute(ctx: DriverExecuteContext): Promise<DriverExecuteResponse> {
    const intentType = String(ctx.intent.type ?? "");
    if (intentType === "polymarket_place_order") {
      return this.executePlace(ctx);
    }
    if (intentType === "polymarket_cancel_order") {
      return this.executeCancel(ctx);
    }
    return { status: "rejected", reason: "unsupported_intent" };
  }

  private async executePlace(ctx: DriverExecuteContext): Promise<DriverExecuteResponse> {
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

    if (!ensureRealMode(ctx.config)) {
      return { status: "rejected", reason: "polymarket_real_disabled" };
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
            payload: { order_id: existingOrder.orderId, client_order_id: clientOrderId, quote_id: ctx.quote.quoteId }
          });
          createReceipt(ctx.db, {
            agentId: ctx.quote.agentId,
            userId: ctx.quote.userId,
            source: "execution",
            eventId: event.event_id,
            externalRef: existingOrder.orderId,
            whatHappened: "Order already exists.",
            whyChanged: "idempotent_replay",
            whatHappensNext: "No new hold created."
          });
        });
        tx();
        return { status: "idempotent", exec_id: execId, external_ref: existingOrder.orderId };
      }
    }

    let orderId: string | null = null;
    let clobResponse: Record<string, unknown> | null = null;
    try {
      const client = await this.clientFactory(ctx.config);
      clobResponse = await client.createAndPostOrder(
        {
          tokenID: String(intent.token_id),
          price: Number(intent.price),
          size: Number(intent.size),
          side: Side.BUY
        },
        undefined,
        OrderType.GTC
      );
      orderId = extractOrderId(clobResponse);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "order_post_failed";
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

    const responseError = clobResponse ? orderResponseError(clobResponse) : null;
    if (!orderId || responseError) {
      const reason = responseError ?? "order_post_failed";
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
        authId: orderId,
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
        type: "polymarket_order_posted",
        payload: {
          quote_id: ctx.quote.quoteId,
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
        whatHappened: "Order posted.",
        whyChanged: "order_posted",
        whatHappensNext: "Order is open."
      });

      const holdEvent = appendEvent(ctx.db, ctx.sqlite, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        type: "polymarket_hold_created",
        payload: { order_id: orderId, amount_cents: costCents, quote_id: ctx.quote.quoteId }
      });
      createReceipt(ctx.db, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        source: "execution",
        eventId: holdEvent.event_id,
        externalRef: orderId,
        whatHappened: `Hold created. amount_cents=${costCents}`,
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
        whatHappensNext: "Order is open."
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

  private async executeCancel(ctx: DriverExecuteContext): Promise<DriverExecuteResponse> {
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

    if (!ensureRealMode(ctx.config)) {
      return { status: "rejected", reason: "polymarket_real_disabled" };
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

    const execId = newId("exec");
    const now = nowSeconds();
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
          payload: { order_id: orderId, quote_id: ctx.quote.quoteId }
        });
        createReceipt(ctx.db, {
          agentId: ctx.quote.agentId,
          userId: ctx.quote.userId,
          source: "execution",
          eventId: event.event_id,
          externalRef: orderId,
          whatHappened: "Order already canceled.",
          whyChanged: "idempotent_replay",
          whatHappensNext: "No action required."
        });
      });
      tx();
      return { status: "idempotent", exec_id: execId, external_ref: orderId };
    }

    try {
      const client = await this.clientFactory(ctx.config);
      await client.cancelOrder({ orderID: orderId });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "cancel_failed";
      const event = appendEvent(ctx.db, ctx.sqlite, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        type: "execution_failed",
        payload: { reason, quote_id: ctx.quote.quoteId, order_id: orderId }
      });
      createReceipt(ctx.db, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        source: "execution",
        eventId: event.event_id,
        externalRef: orderId,
        whatHappened: "Execution failed before apply.",
        whyChanged: reason,
        whatHappensNext: "Review order status and retry."
      });
      return { status: "failed", reason };
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
        payload: { order_id: orderId, quote_id: ctx.quote.quoteId }
      });
      createReceipt(ctx.db, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        source: "execution",
        eventId: orderEvent.event_id,
        externalRef: orderId,
        whatHappened: "Order canceled.",
        whyChanged: "canceled",
        whatHappensNext: "Order is closed."
      });

      const holdEvent = appendEvent(ctx.db, ctx.sqlite, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        type: "polymarket_hold_released",
        payload: { order_id: orderId, amount_cents: existingOrder.costCents, quote_id: ctx.quote.quoteId }
      });
      createReceipt(ctx.db, {
        agentId: ctx.quote.agentId,
        userId: ctx.quote.userId,
        source: "execution",
        eventId: holdEvent.event_id,
        externalRef: orderId,
        whatHappened: `Hold released. amount_cents=${existingOrder.costCents}`,
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
