import Database from "better-sqlite3";
import { and, desc, eq } from "drizzle-orm";
import {
  agentSpendSnapshot,
  agents,
  baseUsdcBalanceCache,
  budgets,
  policies
} from "../db/schema.js";
import type { DbClient } from "../db/database.js";
import type { Config } from "../config.js";
import { nowSeconds } from "./utils.js";

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

type PolicyShape = {
  per_intent_limit: Record<string, { max_per_day?: number }>;
  daily_limit: { max_spend_cents?: number };
  allowlist: string[];
  blocklist: string[];
  step_up_threshold: { spend_cents?: number };
};

function getPolicy(db: DbClient, agentId: string, userId: string): PolicyShape {
  const row = db
    .select()
    .from(policies)
    .where(and(eq(policies.agentId, agentId), eq(policies.userId, userId)))
    .orderBy(desc(policies.createdAt))
    .get() as typeof policies.$inferSelect | undefined;
  return {
    per_intent_limit: parseJson(row?.perIntentLimitJson, {}),
    daily_limit: parseJson(row?.dailyLimitJson, {}),
    allowlist: parseJson(row?.allowlistJson, []),
    blocklist: parseJson(row?.blocklistJson, []),
    step_up_threshold: parseJson(row?.stepUpThresholdJson, {})
  };
}

function getReservedOutgoingCents(sqlite: Database, agentId: string) {
  const row = sqlite
    .prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) as total FROM base_usdc_pending_txs WHERE agent_id = ? AND status = 'pending'"
    )
    .get(agentId) as { total?: number } | undefined;
  return row?.total ?? 0;
}

function getReservedHoldCents(sqlite: Database, agentId: string) {
  const row = sqlite
    .prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) as total FROM card_holds WHERE agent_id = ? AND status = 'pending'"
    )
    .get(agentId) as { total?: number } | undefined;
  return row?.total ?? 0;
}

export function refreshAgentSpendSnapshot(input: {
  db: DbClient;
  sqlite: Database;
  config: Config;
  agentId: string;
}) {
  const { db, sqlite, config, agentId } = input;
  const agent = db.select().from(agents).where(eq(agents.agentId, agentId)).get() as
    | typeof agents.$inferSelect
    | undefined;
  if (!agent) return null;

  const budget = db.select().from(budgets).where(eq(budgets.agentId, agentId)).get() as
    | typeof budgets.$inferSelect
    | undefined;
  if (!budget) return null;

  const policy = getPolicy(db, agentId, agent.userId);
  const dailyMax = policy.daily_limit.max_spend_cents ?? budget.dailySpendCents;
  const dailyRemaining = Math.max(0, dailyMax - budget.dailySpendUsedCents);
  const policySpendableCents = Math.min(budget.creditsCents, dailyRemaining);

  const balanceRow = db
    .select()
    .from(baseUsdcBalanceCache)
    .where(eq(baseUsdcBalanceCache.agentId, agentId))
    .get() as typeof baseUsdcBalanceCache.$inferSelect | undefined;
  const confirmedBalanceCents = balanceRow?.confirmedBalanceCents ?? 0;

  const reservedOutgoingCents = getReservedOutgoingCents(sqlite, agentId);
  const reservedHoldsCents = getReservedHoldCents(sqlite, agentId);
  const confirmedSpendableCents =
    confirmedBalanceCents - reservedOutgoingCents - reservedHoldsCents - config.USDC_BUFFER_CENTS;
  const effectiveSpendPowerCents =
    config.ENV_TYPE === "base_usdc"
      ? Math.min(policySpendableCents, confirmedSpendableCents)
      : policySpendableCents;

  const now = nowSeconds();
  const existing = db
    .select()
    .from(agentSpendSnapshot)
    .where(eq(agentSpendSnapshot.agentId, agentId))
    .get() as typeof agentSpendSnapshot.$inferSelect | undefined;
  const next = {
    agentId,
    confirmedBalanceCents,
    reservedOutgoingCents,
    reservedHoldsCents,
    policySpendableCents,
    effectiveSpendPowerCents,
    updatedAt: now
  };
  if (!existing) {
    db.insert(agentSpendSnapshot).values(next).run();
  } else {
    db.update(agentSpendSnapshot).set(next).where(eq(agentSpendSnapshot.agentId, agentId)).run();
  }

  return next;
}
