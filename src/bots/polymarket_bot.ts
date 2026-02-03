import type Database from "better-sqlite3";
import { eq, and } from "drizzle-orm";
import type { DbClient } from "../db/database.js";
import { agents, polymarketOrders, cardHolds } from "../db/schema.js";
import type { Config } from "../config.js";
import { appendEvent } from "../kernel/events.js";
import { createReceipt } from "../kernel/receipts.js";
import { nowSeconds, newId } from "../kernel/utils.js";

type GammaMarket = {
  id?: string;
  slug?: string | null;
  question?: string | null;
  volume?: string | number;
  volumeNum?: string | number;
  liquidity?: string | number;
  liquidityNum?: string | number;
  volume24hr?: string | number;
  clobTokenIds?: string | string[];
};

type PolymarketTopMarket = {
  slug: string;
  volume: number;
  liquidity: number;
  clobTokenIds: string[];
};

export type PolymarketBotStatus = {
  running: boolean;
  killed: boolean;
  agent_id: string | null;
  loop_seconds: number;
  last_tick_at: number | null;
  next_tick_at: number | null;
  last_trade_at: number | null;
  trading_enabled: boolean;
};

export type PolymarketBotKillResult = {
  killed: boolean;
  stopped: boolean;
  orders_cancelled: number;
  receipt_id: string | null;
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function parseNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeTokenIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).filter((entry) => entry.length > 0);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => String(entry)).filter((entry) => entry.length > 0);
      }
    } catch {
      return [];
    }
  }
  return [];
}

function pickSlug(market: GammaMarket): string {
  const slug = String(market.slug ?? "").trim();
  if (slug) return slug;
  const question = String(market.question ?? "").trim();
  if (question) return question;
  return String(market.id ?? "unknown");
}

function formatMetric(value: number) {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1000) return value.toFixed(0);
  if (value >= 100) return value.toFixed(1);
  return value.toFixed(2);
}

function formatTopMarkets(markets: PolymarketTopMarket[]) {
  if (markets.length === 0) return "none";
  return markets
    .map(
      (market) =>
        `${market.slug} (vol=${formatMetric(market.volume)}, liq=${formatMetric(market.liquidity)})`
    )
    .join("; ");
}

async function fetchActiveMarkets(host: string, fetcher: Fetcher): Promise<GammaMarket[]> {
  const base = host.endsWith("/") ? host.slice(0, -1) : host;
  const limit = 100;
  const markets: GammaMarket[] = [];
  let offset = 0;
  let page = 0;
  while (page < 10) {
    const url = new URL(`${base}/markets`);
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("order", "volume");
    url.searchParams.set("ascending", "false");
    const res = await fetcher(url.toString());
    if (!res.ok) {
      throw new Error(`gamma_fetch_failed_${res.status}`);
    }
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) break;
    if (data.length === 0) break;
    markets.push(...(data as GammaMarket[]));
    if (data.length < limit) break;
    offset += limit;
    page += 1;
  }
  return markets;
}

function rankMarkets(markets: GammaMarket[]): PolymarketTopMarket[] {
  const normalized = markets.map((market) => {
    const volume = parseNumber(market.volumeNum ?? market.volume ?? market.volume24hr ?? 0);
    const liquidity = parseNumber(market.liquidityNum ?? market.liquidity ?? 0);
    return {
      slug: pickSlug(market),
      volume,
      liquidity,
      clobTokenIds: normalizeTokenIds(market.clobTokenIds)
    };
  });
  normalized.sort((a, b) => {
    if (b.volume !== a.volume) return b.volume - a.volume;
    return b.liquidity - a.liquidity;
  });
  return normalized.slice(0, 3);
}

/**
 * Get the total Polymarket spend (in cents) for an agent today (UTC).
 */
function getPolymarketSpendTodayCents(db: DbClient, agentId: string): number {
  const now = new Date();
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;

  // Sum up all pending/filled polymarket holds created since UTC midnight
  const holds = db
    .select()
    .from(cardHolds)
    .where(
      and(
        eq(cardHolds.agentId, agentId),
        eq(cardHolds.source, "polymarket")
      )
    )
    .all() as (typeof cardHolds.$inferSelect)[];

  let totalCents = 0;
  for (const hold of holds) {
    if (hold.createdAt >= utcMidnight && (hold.status === "pending" || hold.status === "settled")) {
      totalCents += hold.amountCents;
    }
  }
  return totalCents;
}

/**
 * Get count of open orders for an agent.
 */
function getOpenOrderCount(db: DbClient, agentId: string): number {
  const orders = db
    .select()
    .from(polymarketOrders)
    .where(
      and(
        eq(polymarketOrders.agentId, agentId),
        eq(polymarketOrders.status, "open")
      )
    )
    .all();
  return orders.length;
}

/**
 * Get total held cents for polymarket orders.
 */
function getOpenHoldsCents(db: DbClient, agentId: string): number {
  const holds = db
    .select()
    .from(cardHolds)
    .where(
      and(
        eq(cardHolds.agentId, agentId),
        eq(cardHolds.source, "polymarket"),
        eq(cardHolds.status, "pending")
      )
    )
    .all() as (typeof cardHolds.$inferSelect)[];

  return holds.reduce((sum, h) => sum + h.amountCents, 0);
}

export class PolymarketBot {
  private db: DbClient;
  private sqlite: Database;
  private config: Config;
  private timer: NodeJS.Timeout | null = null;
  private agentId: string | null = null;
  private lastTickAt: number | null = null;
  private lastTradeAt: number | null = null;
  private killed: boolean = false;
  private fetcher: Fetcher;

  constructor(db: DbClient, sqlite: Database, config: Config, options: { fetcher?: Fetcher } = {}) {
    this.db = db;
    this.sqlite = sqlite;
    this.config = config;
    this.fetcher = options.fetcher ?? fetch;
  }

  async start(agentId?: string): Promise<PolymarketBotStatus> {
    const normalizedAgentId = (agentId ?? this.config.POLY_BOT_AGENT_ID ?? "").trim();
    if (!normalizedAgentId) {
      throw new Error("agent_id_required");
    }
    if (this.timer) {
      this.stop();
    }
    this.killed = false;
    this.agentId = normalizedAgentId;
    await this.tickOnce();
    const loopSeconds = Math.max(1, this.config.POLY_BOT_LOOP_SECONDS);
    this.timer = setInterval(() => {
      void this.tickOnce();
    }, loopSeconds * 1000);
    return this.status();
  }

  stop(): PolymarketBotStatus {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.agentId = null;
    return this.status();
  }

  /**
   * Emergency kill switch. Stops the bot, marks it as killed, and optionally cancels open orders.
   */
  async kill(options: {
    db: DbClient;
    sqlite: Database;
    cancelOrders?: boolean;
  }): Promise<PolymarketBotKillResult> {
    const { db, sqlite, cancelOrders = false } = options;
    const agentId = this.agentId;
    const wasRunning = Boolean(this.timer);

    // Stop the bot immediately
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.killed = true;

    let ordersCancelled = 0;
    let receiptId: string | null = null;

    if (agentId) {
      const agent = db
        .select()
        .from(agents)
        .where(eq(agents.agentId, agentId))
        .get() as typeof agents.$inferSelect | undefined;

      if (agent) {
        const now = nowSeconds();

        // Optionally cancel all open orders
        if (cancelOrders) {
          const openOrders = db
            .select()
            .from(polymarketOrders)
            .where(
              and(
                eq(polymarketOrders.agentId, agentId),
                eq(polymarketOrders.status, "open")
              )
            )
            .all();

          for (const order of openOrders) {
            // Mark order as cancelled (soft cancel - actual CLOB cancel would happen via reconcile)
            db.update(polymarketOrders)
              .set({ status: "cancelled", updatedAt: now })
              .where(eq(polymarketOrders.orderId, order.orderId))
              .run();

            // Release the hold if exists (hold authId = order orderId in dryrun driver)
            db.update(cardHolds)
              .set({ status: "released", updatedAt: now })
              .where(eq(cardHolds.authId, order.orderId))
              .run();

            ordersCancelled++;
          }
        }

        // Emit kill event and receipt
        const event = appendEvent(db, sqlite, {
          agentId,
          userId: agent.userId,
          type: "polymarket_bot_killed",
          payload: {
            agent_id: agentId,
            was_running: wasRunning,
            orders_cancelled: ordersCancelled,
            kill_reason: "manual_kill_switch"
          },
          occurredAt: now
        });

        const receipt = createReceipt(db, {
          agentId,
          userId: agent.userId,
          source: "execution",
          eventId: event.event_id,
          externalRef: `kill_${now}`,
          whatHappened: `Polymarket bot killed. orders_cancelled=${ordersCancelled}`,
          whyChanged: "kill_switch",
          whatHappensNext: "Bot stopped. Manual restart required.",
          occurredAt: now
        });

        receiptId = receipt.receipt_id;
      }
    }

    this.agentId = null;

    return {
      killed: true,
      stopped: wasRunning,
      orders_cancelled: ordersCancelled,
      receipt_id: receiptId
    };
  }

  status(): PolymarketBotStatus {
    const loopSeconds = Math.max(1, this.config.POLY_BOT_LOOP_SECONDS);
    const nextTickAt = this.timer && this.lastTickAt ? this.lastTickAt + loopSeconds : null;
    return {
      running: Boolean(this.timer),
      killed: this.killed,
      agent_id: this.agentId,
      loop_seconds: loopSeconds,
      last_tick_at: this.lastTickAt,
      next_tick_at: nextTickAt,
      last_trade_at: this.lastTradeAt,
      trading_enabled: Boolean(this.config.POLY_BOT_TRADING_ENABLED)
    };
  }

  async tickOnce() {
    if (!this.agentId) return;
    if (this.killed) return;

    const now = nowSeconds();
    this.lastTickAt = now;

    try {
      const agent = this.db
        .select()
        .from(agents)
        .where(eq(agents.agentId, this.agentId))
        .get() as typeof agents.$inferSelect | undefined;
      if (!agent) {
        console.error(`[polymarket-bot] agent_missing=${this.agentId}`);
        return;
      }

      const markets = await fetchActiveMarkets(this.config.POLY_GAMMA_HOST, this.fetcher);
      const topMarkets = rankMarkets(markets);

      console.error(
        `[polymarket-bot] agent_id=${this.agentId} scanned=${markets.length} top=${topMarkets
          .map((market) => market.slug)
          .join(",")}`
      );

      // Check if trading is enabled and we have required config
      const tradingEnabled = this.config.POLY_BOT_TRADING_ENABLED;
      const hasTradeConfig = Boolean(
        this.config.POLY_TRADE_TOKEN_ID &&
        this.config.POLY_TRADE_PRICE !== null &&
        this.config.POLY_TRADE_SIZE !== null
      );

      let tradeDecision: "observe_only" | "no_config" | "cooldown" | "daily_limit" | "order_limit" | "hold_limit" | "would_trade" | "trade_placed" = "observe_only";
      let tradeDetails: Record<string, unknown> = {};

      if (tradingEnabled && hasTradeConfig) {
        // Check cooldown
        const minSecondsBetween = this.config.POLY_MIN_SECONDS_BETWEEN_TRADES;
        const timeSinceLastTrade = this.lastTradeAt ? now - this.lastTradeAt : Infinity;

        if (timeSinceLastTrade < minSecondsBetween) {
          tradeDecision = "cooldown";
          tradeDetails = {
            seconds_until_eligible: minSecondsBetween - timeSinceLastTrade
          };
        } else {
          // Check daily limit
          const spendTodayCents = getPolymarketSpendTodayCents(this.db, this.agentId);
          const tradeCostCents = Math.ceil(
            (this.config.POLY_TRADE_PRICE ?? 0) * (this.config.POLY_TRADE_SIZE ?? 0) * 100
          );
          const maxDailyCents = this.config.POLY_MAX_PER_DAY_CENTS;

          if (maxDailyCents > 0 && spendTodayCents + tradeCostCents > maxDailyCents) {
            tradeDecision = "daily_limit";
            tradeDetails = {
              spend_today_cents: spendTodayCents,
              trade_cost_cents: tradeCostCents,
              max_daily_cents: maxDailyCents
            };
          } else {
            // Check order count limit
            const openOrderCount = getOpenOrderCount(this.db, this.agentId);
            if (openOrderCount >= this.config.POLY_MAX_OPEN_ORDERS) {
              tradeDecision = "order_limit";
              tradeDetails = {
                open_orders: openOrderCount,
                max_orders: this.config.POLY_MAX_OPEN_ORDERS
              };
            } else {
              // Check open holds limit
              const openHoldsCents = getOpenHoldsCents(this.db, this.agentId);
              if (openHoldsCents + tradeCostCents > this.config.POLY_MAX_OPEN_HOLDS_CENTS) {
                tradeDecision = "hold_limit";
                tradeDetails = {
                  open_holds_cents: openHoldsCents,
                  trade_cost_cents: tradeCostCents,
                  max_holds_cents: this.config.POLY_MAX_OPEN_HOLDS_CENTS
                };
              } else {
                // Check per-order limit
                if (tradeCostCents > this.config.POLY_MAX_PER_ORDER_CENTS) {
                  tradeDecision = "order_limit";
                  tradeDetails = {
                    trade_cost_cents: tradeCostCents,
                    max_per_order_cents: this.config.POLY_MAX_PER_ORDER_CENTS
                  };
                } else {
                  // All checks passed - would trade (but we don't execute in bot tick)
                  // The actual trade would go through kernel canDo -> execute flow
                  tradeDecision = "would_trade";
                  tradeDetails = {
                    token_id: this.config.POLY_TRADE_TOKEN_ID,
                    market_slug: this.config.POLY_TRADE_MARKET_SLUG,
                    price: this.config.POLY_TRADE_PRICE,
                    size: this.config.POLY_TRADE_SIZE,
                    cost_cents: tradeCostCents,
                    note: "Trade eligible. Use MCP tool or API to place order."
                  };
                }
              }
            }
          }
        }
      } else if (tradingEnabled && !hasTradeConfig) {
        tradeDecision = "no_config";
        tradeDetails = {
          missing: ["POLY_TRADE_TOKEN_ID", "POLY_TRADE_PRICE", "POLY_TRADE_SIZE"]
            .filter(key => !this.config[key as keyof Config])
        };
      }

      const event = appendEvent(this.db, this.sqlite, {
        agentId: this.agentId,
        userId: agent.userId,
        type: "polymarket_bot_tick",
        payload: {
          agent_id: this.agentId,
          observe_only: tradeDecision === "observe_only",
          markets_scanned: markets.length,
          top_markets: topMarkets,
          trading_enabled: tradingEnabled,
          trade_decision: tradeDecision,
          trade_details: tradeDetails
        },
        occurredAt: now
      });

      const whatHappensNext = tradingEnabled
        ? tradeDecision === "would_trade"
          ? "Trade eligible. Use API to place order."
          : `Trading ${tradeDecision}.`
        : "Trading disabled.";

      createReceipt(this.db, {
        agentId: this.agentId,
        userId: agent.userId,
        source: "execution",
        eventId: event.event_id,
        externalRef: this.agentId,
        whatHappened: `Polymarket bot tick. decision=${tradeDecision} scanned=${markets.length} top=${formatTopMarkets(
          topMarkets
        )}`,
        whyChanged: tradeDecision,
        whatHappensNext,
        occurredAt: now
      });
    } catch (error) {
      console.error(`[polymarket-bot] tick_failed=${error instanceof Error ? error.message : "unknown"}`);
    }
  }
}
