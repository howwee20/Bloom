import Database from "better-sqlite3";
import { and, desc, eq, gt } from "drizzle-orm";
import {
  agents,
  agentTokens,
  budgets,
  baseUsdcActionDedup,
  baseUsdcPendingTxs,
  economyPrices,
  events,
  executions,
  policies,
  quotes,
  receipts,
  stepUpChallenges,
  stepUpTokens,
  users,
  agentSpendSnapshot
} from "../db/schema.js";
import type { DbClient } from "../db/database.js";
import type { EnvResult, IEnvironment } from "../env/IEnvironment.js";
import { BaseUsdcWorld } from "../env/base_usdc.js";
import { appendEvent } from "./events.js";
import { createReceipt } from "./receipts.js";
import { dayStartEpoch, newId, nowSeconds } from "./utils.js";
import type { Config } from "../config.js";
import { getAddress } from "viem";
import { createHash, randomBytes } from "node:crypto";
import { refreshAgentSpendSnapshot } from "./spend_snapshot.js";

export type CanDoRequest = {
  user_id: string;
  agent_id: string;
  intent_json: Record<string, unknown>;
  idempotency_key?: string;
};

export type CanDoResponse = {
  quote_id: string;
  allowed: boolean;
  requires_step_up: boolean;
  reason: string;
  expires_at: number;
  idempotency_key: string;
};

export type ExecuteRequest = {
  quote_id: string;
  idempotency_key: string;
  step_up_token?: string;
  override_freshness?: boolean;
};

export type ExecuteResponse = {
  status: "applied" | "failed" | "rejected" | "idempotent";
  exec_id?: string;
  external_ref?: string;
  reason?: string;
};

export type StepUpChallengeRequest = {
  user_id: string;
  agent_id: string;
  quote_id: string;
};

export type StepUpChallengeResponse = {
  challenge_id: string;
  expires_at: number;
  code?: string | null;
  reused?: boolean;
};

export type StepUpConfirmRequest = {
  challenge_id: string;
  code: string;
  decision: "approve" | "deny";
};

export type StepUpConfirmResponse = {
  status: "approved" | "denied";
  step_up_token?: string;
  expires_at?: number;
};

type PolicyShape = {
  per_intent_limit: Record<string, { max_per_day?: number }>;
  daily_limit: { max_spend_cents?: number };
  allowlist: string[];
  blocklist: string[];
  step_up_threshold: { spend_cents?: number };
};

type UsdcObservationSnapshot = {
  confirmed_balance_cents: number;
  observed_block_number: number;
  observed_block_timestamp: number;
  buffer_cents: number;
};

type SpendPowerSnapshot = {
  policy_spendable_cents: number;
  effective_spend_power_cents: number;
  confirmed_balance_cents?: number;
  reserved_outgoing_cents?: number;
  reserved_holds_cents?: number;
  buffer_cents?: number;
  confirmed_usdc_spendable_cents?: number;
  observed_block_number?: number;
  observed_block_timestamp?: number;
};

type ConstraintDecision = {
  allowed: boolean;
  reason: string;
  requires_step_up?: boolean;
  base_cost_cents?: number;
  transfer_amount_cents?: number;
  intent_type?: string;
  spend_power?: SpendPowerSnapshot;
  facts_snapshot?: Record<string, unknown>;
};

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

function getIntentType(intent: Record<string, unknown>) {
  return String(intent.type ?? "");
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeUsdcTransferIntent(intent: Record<string, unknown>) {
  const amountRaw = intent.amount_cents;
  const amount = toFiniteNumber(amountRaw);
  if (amount === null || !Number.isInteger(amount) || !Number.isSafeInteger(amount) || amount <= 0) {
    return { ok: false as const, reason: "invalid_amount_cents" };
  }
  const toRaw = String(intent.to_address ?? "");
  try {
    const toAddress = getAddress(toRaw);
    return {
      ok: true as const,
      intent: {
        ...intent,
        type: "usdc_transfer",
        amount_cents: amount,
        to_address: toAddress
      }
    };
  } catch {
    return { ok: false as const, reason: "invalid_to_address" };
  }
}

function hashStepUpCode(challengeId: string, code: string) {
  return createHash("sha256").update(`${challengeId}:${code}`).digest("hex");
}

function hashStepUpToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function generateStepUpCode() {
  const raw = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return String(raw).padStart(6, "0");
}

function generateStepUpToken() {
  return `stepup_${randomBytes(24).toString("hex")}`;
}

export class Kernel {
  private db: DbClient;
  private sqlite: Database;
  private env: IEnvironment;
  private config: Config;

  constructor(db: DbClient, sqlite: Database, env: IEnvironment, config: Config) {
    this.db = db;
    this.sqlite = sqlite;
    this.env = env;
    this.config = config;
  }

  private appendEventWithReceipt(input: {
    agentId: string;
    userId: string;
    type: string;
    payload: Record<string, unknown>;
    occurredAt?: number;
    receipt: {
      source: "policy" | "execution" | "env" | "repair";
      externalRef?: string | null;
      whatHappened: string;
      whyChanged: string;
      whatHappensNext: string;
      occurredAt?: number;
    };
  }) {
    const event = appendEvent(this.db, this.sqlite, {
      agentId: input.agentId,
      userId: input.userId,
      type: input.type,
      payload: input.payload,
      occurredAt: input.occurredAt
    });
    const receipt = createReceipt(this.db, {
      agentId: input.agentId,
      userId: input.userId,
      source: input.receipt.source,
      eventId: event.event_id,
      externalRef: input.receipt.externalRef ?? null,
      whatHappened: input.receipt.whatHappened,
      whyChanged: input.receipt.whyChanged,
      whatHappensNext: input.receipt.whatHappensNext,
      occurredAt: input.receipt.occurredAt ?? event.occurred_at
    });
    return { event, receipt };
  }

  private computePolicySpendable(
    budget: typeof budgets.$inferSelect,
    policy: PolicyShape,
    transferAmount: number
  ) {
    const dailyMax = policy.daily_limit.max_spend_cents ?? budget.dailySpendCents;
    const dailyRemaining = Math.max(0, dailyMax - budget.dailySpendUsedCents);
    const policySpendableCents = Math.min(budget.creditsCents, dailyRemaining + transferAmount);
    return { policySpendableCents, dailyMax, dailyRemaining };
  }

  private getReservedOutgoingCents(agentId: string) {
    const row = this.sqlite
      .prepare(
        "SELECT COALESCE(SUM(amount_cents), 0) as total FROM base_usdc_pending_txs WHERE agent_id = ? AND status = 'pending'"
      )
      .get(agentId) as { total?: number } | undefined;
    return row?.total ?? 0;
  }

  private getReservedHoldCents(agentId: string) {
    const row = this.sqlite
      .prepare("SELECT COALESCE(SUM(amount_cents), 0) as total FROM card_holds WHERE agent_id = ? AND status = 'pending'")
      .get(agentId) as { total?: number } | undefined;
    return row?.total ?? 0;
  }

  private extractUsdcObservationSnapshot(observation: Record<string, unknown>): UsdcObservationSnapshot | null {
    const confirmed = toFiniteNumber(observation.confirmed_balance_cents);
    const blockNumber = toFiniteNumber(observation.observed_block_number);
    const blockTimestamp = toFiniteNumber(observation.observed_block_timestamp);
    if (confirmed === null || blockNumber === null || blockTimestamp === null) return null;
    const buffer = toFiniteNumber(observation.buffer_cents) ?? this.config.USDC_BUFFER_CENTS;
    return {
      confirmed_balance_cents: confirmed,
      observed_block_number: blockNumber,
      observed_block_timestamp: blockTimestamp,
      buffer_cents: buffer
    };
  }

  private async hasSufficientGas(agentId: string) {
    if (this.env.envName !== "base_usdc") return true;
    if (!(this.env instanceof BaseUsdcWorld)) return false;
    try {
      const balanceWei = await this.env.getGasBalanceWei(agentId);
      return balanceWei > 0n;
    } catch {
      return false;
    }
  }

  createAgent(input: { userId?: string; agentId?: string } = {}) {
    const now = nowSeconds();
    const userId = input.userId ?? newId("user");
    const agentId = input.agentId ?? newId("agent");
    const existingAgent = this.db.select().from(agents).where(eq(agents.agentId, agentId)).get() as
      | typeof agents.$inferSelect
      | undefined;
    if (existingAgent) {
      if (existingAgent.userId !== userId) {
        throw new Error("agent_id_in_use");
      }
      return { user_id: existingAgent.userId, agent_id: existingAgent.agentId };
    }

    const dayStart = dayStartEpoch(now);
    const defaultPolicy: PolicyShape = {
      per_intent_limit: {
        request_job: { max_per_day: 20 },
        submit_job: { max_per_day: 50 },
        buy_tool: { max_per_day: 5 },
        send_credits: { max_per_day: 10 }
      },
      daily_limit: { max_spend_cents: this.config.DEFAULT_DAILY_SPEND_CENTS },
      allowlist: ["request_job", "submit_job", "buy_tool", "send_credits"],
      blocklist: [],
      step_up_threshold: { spend_cents: 1000 }
    };
    if (this.env.envName === "base_usdc") {
      defaultPolicy.per_intent_limit.usdc_transfer = { max_per_day: 10 };
      defaultPolicy.allowlist = [...defaultPolicy.allowlist, "usdc_transfer"];
    }

    const tx = this.sqlite.transaction(() => {
      const user = this.db.select().from(users).where(eq(users.userId, userId)).get();
      const createdUser = !user;
      if (!user) {
        this.db.insert(users).values({ userId, createdAt: now }).run();
      }
      this.db.insert(agents).values({
        agentId,
        userId,
        status: "active",
        createdAt: now,
        updatedAt: now
      }).run();

      this.db.insert(budgets).values({
        agentId,
        creditsCents: this.config.DEFAULT_CREDITS_CENTS,
        dailySpendCents: this.config.DEFAULT_DAILY_SPEND_CENTS,
        dailySpendUsedCents: 0,
        lastResetAt: dayStart,
        updatedAt: now
      }).run();

      this.db.insert(policies).values({
        policyId: newId("policy"),
        userId,
        agentId,
        perIntentLimitJson: defaultPolicy.per_intent_limit,
        dailyLimitJson: defaultPolicy.daily_limit,
        allowlistJson: defaultPolicy.allowlist,
        blocklistJson: defaultPolicy.blocklist,
        stepUpThresholdJson: defaultPolicy.step_up_threshold,
        createdAt: now
      }).run();

      refreshAgentSpendSnapshot({
        db: this.db,
        sqlite: this.sqlite,
        config: this.config,
        agentId
      });

      this.appendEventWithReceipt({
        agentId,
        userId,
        type: "kernel.agent_created",
        payload: {
          user_id: userId,
          agent_id: agentId,
          created_at: now,
          created_user: createdUser,
          defaults: {
            credits_cents: this.config.DEFAULT_CREDITS_CENTS,
            daily_spend_cents: this.config.DEFAULT_DAILY_SPEND_CENTS,
            daily_spend_used_cents: 0,
            last_reset_at: dayStart,
            policy: defaultPolicy
          }
        },
        receipt: {
          source: "policy",
          whatHappened: "Agent created.",
          whyChanged: "kernel.agent_created",
          whatHappensNext: "Agent can request quotes."
        }
      });
    });
    tx();

    return { user_id: userId, agent_id: agentId };
  }

  private getPolicy(agentId: string, userId: string): PolicyShape {
    const row = this.db
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

  private ensureDailyReset(agentId: string, now: number) {
    const budget = this.db
      .select()
      .from(budgets)
      .where(eq(budgets.agentId, agentId))
      .get() as typeof budgets.$inferSelect | undefined;
    if (!budget) return;
    const dayStart = dayStartEpoch(now);
    if (budget.lastResetAt < dayStart) {
      const agent = this.db.select().from(agents).where(eq(agents.agentId, agentId)).get() as
        | typeof agents.$inferSelect
        | undefined;
      if (!agent) return;
      const prev = {
        daily_spend_used_cents: budget.dailySpendUsedCents,
        daily_spend_cents: budget.dailySpendCents,
        last_reset_at: budget.lastResetAt
      };
      const next = {
        daily_spend_used_cents: 0,
        daily_spend_cents: budget.dailySpendCents,
        last_reset_at: dayStart
      };
      const tx = this.sqlite.transaction(() => {
        this.db
          .update(budgets)
          .set({ dailySpendUsedCents: 0, lastResetAt: dayStart, updatedAt: now })
          .where(eq(budgets.agentId, agentId))
          .run();
        this.appendEventWithReceipt({
          agentId,
          userId: agent.userId,
          type: "kernel.daily_reset",
          payload: {
            agent_id: agentId,
            user_id: agent.userId,
            occurred_at: now,
            day_start: dayStart,
            previous: prev,
            next
          },
          receipt: {
            source: "policy",
            whatHappened: "Daily counters reset (UTC day rollover).",
            whyChanged: "kernel.daily_reset",
            whatHappensNext: "Daily spend budget renewed.",
            occurredAt: now
          }
        });
      });
      tx();
    }
  }

  private estimateIntentCost(intent: Record<string, unknown>) {
    const type = getIntentType(intent);
    const priceRow = this.db
      .select()
      .from(economyPrices)
      .where(eq(economyPrices.priceKey, `${type}_cost`))
      .get() as typeof economyPrices.$inferSelect | undefined;
    const base = priceRow?.priceCents ?? 50;
    const transferAmount =
      type === "send_credits" || type === "usdc_transfer"
        ? Math.max(0, Number(intent.amount_cents ?? 0))
        : 0;
    return { baseCost: base, transferAmount };
  }

  private getIntentCountToday(agentId: string, intentType: string, dayStart: number) {
    const rows = this.sqlite
      .prepare(
        "SELECT q.intent_json as intent_json FROM executions e JOIN quotes q ON e.quote_id = q.quote_id WHERE e.agent_id = ? AND e.status = 'applied' AND e.created_at >= ?"
      )
      .all(agentId, dayStart) as { intent_json: string }[];
    let count = 0;
    for (const row of rows) {
      const intent = parseJson<Record<string, unknown>>(row.intent_json, {});
      if (getIntentType(intent) === intentType) count += 1;
    }
    return count;
  }

  private async evaluateConstraints(input: {
    agentId: string;
    userId: string;
    intent: Record<string, unknown>;
  }, options: { skipFreshness?: boolean } = {}): Promise<ConstraintDecision> {
    const now = nowSeconds();
    const agent = this.db.select().from(agents).where(eq(agents.agentId, input.agentId)).get() as
      | typeof agents.$inferSelect
      | undefined;
    if (!agent || agent.userId !== input.userId) {
      return { allowed: false, reason: "agent_not_found" };
    }
    if (agent.status !== "active") {
      return { allowed: false, reason: `agent_${agent.status}` };
    }

    this.ensureDailyReset(input.agentId, now);

    const policy = this.getPolicy(input.agentId, input.userId);
    const intentType = getIntentType(input.intent);
    if (policy.blocklist.includes(intentType)) {
      return { allowed: false, reason: "blocked_intent" };
    }
    if (policy.allowlist.length > 0 && !policy.allowlist.includes(intentType)) {
      return { allowed: false, reason: "intent_not_allowlisted" };
    }

    const dayStart = dayStartEpoch(now);
    const countToday = this.getIntentCountToday(input.agentId, intentType, dayStart);
    const maxPerDay = policy.per_intent_limit[intentType]?.max_per_day;
    if (maxPerDay !== undefined && countToday >= maxPerDay) {
      return { allowed: false, reason: "per_intent_limit_reached" };
    }

    const budget = this.db
      .select()
      .from(budgets)
      .where(eq(budgets.agentId, input.agentId))
      .get() as typeof budgets.$inferSelect | undefined;
    if (!budget) {
      return { allowed: false, reason: "budget_missing" };
    }

    if (budget.creditsCents <= 0) {
      return { allowed: false, reason: "agent_dead" };
    }

    const { baseCost, transferAmount } = this.estimateIntentCost(input.intent);
    const { policySpendableCents, dailyMax, dailyRemaining } = this.computePolicySpendable(
      budget,
      policy,
      transferAmount
    );
    const reservedOutgoingCents = this.getReservedOutgoingCents(input.agentId);
    const reservedHoldsCents = this.getReservedHoldCents(input.agentId);
    const policySnapshot = {
      daily_limit_cents: dailyMax,
      daily_remaining_cents: dailyRemaining,
      per_intent_max_per_day: maxPerDay ?? null,
      step_up_threshold_cents: policy.step_up_threshold.spend_cents ?? null
    };
    const factsSnapshotBase = {
      policy_caps: policySnapshot,
      reserves: {
        reserved_outgoing_cents: reservedOutgoingCents,
        reserved_holds_cents: reservedHoldsCents
      },
      buffer_cents: this.config.USDC_BUFFER_CENTS
    };
    let factsSnapshot = factsSnapshotBase;
    const includeSpendPower = this.env.envName === "base_usdc";
    const spendPowerBase: SpendPowerSnapshot | undefined = includeSpendPower
      ? {
          policy_spendable_cents: policySpendableCents,
          effective_spend_power_cents: policySpendableCents
        }
      : undefined;
    if (budget.dailySpendUsedCents + baseCost > dailyMax) {
      return {
        allowed: false,
        reason: "daily_limit_exceeded",
        ...(spendPowerBase ? { spend_power: spendPowerBase } : {}),
        facts_snapshot: factsSnapshotBase
      };
    }
    if (budget.creditsCents < baseCost + transferAmount) {
      return {
        allowed: false,
        reason: "insufficient_credits",
        ...(spendPowerBase ? { spend_power: spendPowerBase } : {}),
        facts_snapshot: factsSnapshotBase
      };
    }

    if (!options.skipFreshness) {
      const freshness = await this.env.getFreshness();
      if (freshness.status !== "fresh") {
        return {
          allowed: false,
          reason: `env_${freshness.status}`,
          ...(spendPowerBase ? { spend_power: spendPowerBase } : {}),
          facts_snapshot: factsSnapshotBase
        };
      }
    }

    let spendPower = spendPowerBase;
    if (includeSpendPower) {
      let observationSnapshot: UsdcObservationSnapshot | null = null;
      try {
        const observation = await this.env.getObservation(input.agentId);
        observationSnapshot = this.extractUsdcObservationSnapshot(observation as Record<string, unknown>);
      } catch (error) {
        return {
          allowed: false,
          reason: "env_observation_failed",
          spend_power: { ...(spendPowerBase ?? {}), buffer_cents: this.config.USDC_BUFFER_CENTS },
          facts_snapshot: factsSnapshotBase
        };
      }

      if (!observationSnapshot) {
        return {
          allowed: false,
          reason: "env_observation_invalid",
          spend_power: { ...(spendPowerBase ?? {}), buffer_cents: this.config.USDC_BUFFER_CENTS },
          facts_snapshot: factsSnapshotBase
        };
      }

      const confirmedSpendableCents =
        observationSnapshot.confirmed_balance_cents -
        reservedOutgoingCents -
        reservedHoldsCents -
        this.config.USDC_BUFFER_CENTS;
      const effectiveSpendPowerCents = Math.min(policySpendableCents, confirmedSpendableCents);
      factsSnapshot = {
        ...factsSnapshotBase,
        balance_block: {
          observed_block_number: observationSnapshot.observed_block_number,
          observed_block_timestamp: observationSnapshot.observed_block_timestamp
        }
      };
      spendPower = {
        policy_spendable_cents: policySpendableCents,
        effective_spend_power_cents: effectiveSpendPowerCents,
        confirmed_balance_cents: observationSnapshot.confirmed_balance_cents,
        reserved_outgoing_cents: reservedOutgoingCents,
        reserved_holds_cents: reservedHoldsCents,
        buffer_cents: observationSnapshot.buffer_cents,
        confirmed_usdc_spendable_cents: confirmedSpendableCents,
        observed_block_number: observationSnapshot.observed_block_number,
        observed_block_timestamp: observationSnapshot.observed_block_timestamp
      };

      const spendCheckAmount = intentType === "usdc_transfer" ? transferAmount : baseCost + transferAmount;
      if (spendCheckAmount > effectiveSpendPowerCents) {
        return {
          allowed: false,
          reason: "insufficient_confirmed_usdc",
          spend_power: spendPower,
          facts_snapshot: factsSnapshot
        };
      }

      if (intentType === "usdc_transfer") {
        const hasGas = await this.hasSufficientGas(input.agentId);
        if (!hasGas) {
          return {
            allowed: false,
            reason: "insufficient_gas",
            spend_power: spendPower,
            facts_snapshot: factsSnapshot
          };
        }
      }
    }

    const stepUpThreshold = policy.step_up_threshold.spend_cents ?? 1000000;
    const requiresStepUp =
      baseCost >= stepUpThreshold || (this.env.envName === "base_usdc" && intentType === "usdc_transfer");
    return {
      allowed: true,
      reason: "ok",
      requires_step_up: requiresStepUp,
      base_cost_cents: baseCost,
      transfer_amount_cents: transferAmount,
      intent_type: intentType,
      ...(spendPower ? { spend_power: spendPower } : {}),
      facts_snapshot: factsSnapshot
    };
  }

  async canDo(input: CanDoRequest): Promise<CanDoResponse> {
    const idempotencyKey = input.idempotency_key ?? newId("idem");
    const existing = this.db
      .select()
      .from(quotes)
      .where(and(eq(quotes.agentId, input.agent_id), eq(quotes.idempotencyKey, idempotencyKey)))
      .get() as typeof quotes.$inferSelect | undefined;
    if (existing) {
      return {
        quote_id: existing.quoteId,
        allowed: existing.allowed === 1,
        requires_step_up: existing.requiresStepUp === 1,
        reason: existing.reason,
        expires_at: existing.expiresAt,
        idempotency_key: existing.idempotencyKey
      };
    }

    let intent = input.intent_json;
    let normalizationError: string | null = null;
    if (this.env.envName === "base_usdc" && getIntentType(intent) === "usdc_transfer") {
      const normalized = normalizeUsdcTransferIntent(intent);
      if (normalized.ok) {
        intent = normalized.intent;
      } else {
        normalizationError = normalized.reason;
      }
    }

    const decision = normalizationError
      ? ({ allowed: false, reason: normalizationError } as ConstraintDecision)
      : await this.evaluateConstraints({
          agentId: input.agent_id,
          userId: input.user_id,
          intent
        });
    const now = nowSeconds();
    const expiresAt = now + 300;
    const quoteId = newId("quote");

    this.db.insert(quotes).values({
      quoteId,
      userId: input.user_id,
      agentId: input.agent_id,
      intentJson: intent,
      allowed: decision.allowed ? 1 : 0,
      requiresStepUp: decision.requires_step_up ? 1 : 0,
      reason: decision.reason ?? "rejected",
      expiresAt,
      idempotencyKey,
      createdAt: now
    }).run();

    const spendPowerPayload = decision.spend_power ? { spend_power: decision.spend_power } : {};
    const factsPayload = decision.facts_snapshot ? { facts_snapshot: decision.facts_snapshot } : {};
    const event = appendEvent(this.db, this.sqlite, {
      agentId: input.agent_id,
      userId: input.user_id,
      type: "policy_decision",
      payload: {
        allowed: decision.allowed,
        reason: decision.reason,
        requires_step_up: decision.requires_step_up ?? false,
        intent,
        ...spendPowerPayload,
        ...factsPayload
      }
    });

    createReceipt(this.db, {
      agentId: input.agent_id,
      userId: input.user_id,
      source: "policy",
      eventId: event.event_id,
      externalRef: quoteId,
      whatHappened: decision.allowed ? "Policy approved intent." : "Policy rejected intent.",
      whyChanged: decision.reason ?? "unknown",
      whatHappensNext: decision.allowed ? "Quote issued." : "No execution permitted."
    });

    return {
      quote_id: quoteId,
      allowed: decision.allowed,
      requires_step_up: decision.requires_step_up ?? false,
      reason: decision.reason ?? "rejected",
      expires_at: expiresAt,
      idempotency_key: idempotencyKey
    };
  }

  async requestStepUpChallenge(input: StepUpChallengeRequest): Promise<StepUpChallengeResponse> {
    const now = nowSeconds();
    const existing = this.db
      .select()
      .from(stepUpChallenges)
      .where(
        and(
          eq(stepUpChallenges.userId, input.user_id),
          eq(stepUpChallenges.agentId, input.agent_id),
          eq(stepUpChallenges.quoteId, input.quote_id),
          eq(stepUpChallenges.status, "pending")
        )
      )
      .get() as typeof stepUpChallenges.$inferSelect | undefined;

    if (existing) {
      if (existing.expiresAt <= now) {
        this.db
          .update(stepUpChallenges)
          .set({ status: "expired" })
          .where(eq(stepUpChallenges.id, existing.id))
          .run();
      } else {
        return { challenge_id: existing.id, expires_at: existing.expiresAt, reused: true };
      }
    }

    const challengeId = newId("stepup");
    const code = generateStepUpCode();
    const expiresAt = now + Math.max(1, this.config.STEP_UP_CHALLENGE_TTL_SECONDS);
    const codeHash = hashStepUpCode(challengeId, code);

    this.db.insert(stepUpChallenges).values({
      id: challengeId,
      userId: input.user_id,
      agentId: input.agent_id,
      quoteId: input.quote_id,
      status: "pending",
      codeHash,
      createdAt: now,
      expiresAt,
      approvedAt: null
    }).run();

    const event = appendEvent(this.db, this.sqlite, {
      agentId: input.agent_id,
      userId: input.user_id,
      type: "step_up_requested",
      payload: { quote_id: input.quote_id, challenge_id: challengeId, expires_at: expiresAt }
    });
    createReceipt(this.db, {
      agentId: input.agent_id,
      userId: input.user_id,
      source: "policy",
      eventId: event.event_id,
      externalRef: challengeId,
      whatHappened: "Step-up challenge created.",
      whyChanged: "step_up_requested",
      whatHappensNext: "Approve or deny using the local approval UI."
    });

    return { challenge_id: challengeId, expires_at: expiresAt, code };
  }

  async confirmStepUpChallenge(
    input: StepUpConfirmRequest
  ): Promise<{ ok: true; response: StepUpConfirmResponse } | { ok: false; reason: string }> {
    const now = nowSeconds();
    const challenge = this.db
      .select()
      .from(stepUpChallenges)
      .where(eq(stepUpChallenges.id, input.challenge_id))
      .get() as typeof stepUpChallenges.$inferSelect | undefined;
    if (!challenge) {
      return { ok: false, reason: "challenge_not_found" };
    }
    if (challenge.status !== "pending") {
      return { ok: false, reason: "challenge_not_pending" };
    }
    if (challenge.expiresAt <= now) {
      this.db
        .update(stepUpChallenges)
        .set({ status: "expired" })
        .where(eq(stepUpChallenges.id, challenge.id))
        .run();
      return { ok: false, reason: "challenge_expired" };
    }

    const codeHash = hashStepUpCode(challenge.id, input.code);
    if (codeHash !== challenge.codeHash) {
      return { ok: false, reason: "invalid_code" };
    }

    if (input.decision === "deny") {
      this.db
        .update(stepUpChallenges)
        .set({ status: "denied" })
        .where(eq(stepUpChallenges.id, challenge.id))
        .run();
      const event = appendEvent(this.db, this.sqlite, {
        agentId: challenge.agentId,
        userId: challenge.userId,
        type: "step_up_denied",
        payload: { quote_id: challenge.quoteId, challenge_id: challenge.id }
      });
      createReceipt(this.db, {
        agentId: challenge.agentId,
        userId: challenge.userId,
        source: "policy",
        eventId: event.event_id,
        externalRef: challenge.id,
        whatHappened: "Step-up challenge denied.",
        whyChanged: "step_up_denied",
        whatHappensNext: "Execution will remain blocked."
      });
      return { ok: true, response: { status: "denied" } };
    }

    const token = generateStepUpToken();
    const tokenHash = hashStepUpToken(token);
    const tokenExpiresAt = now + Math.max(1, this.config.STEP_UP_TOKEN_TTL_SECONDS);

    const tx = this.sqlite.transaction(() => {
      this.db
        .update(stepUpChallenges)
        .set({ status: "approved", approvedAt: now })
        .where(eq(stepUpChallenges.id, challenge.id))
        .run();
      this.db.insert(stepUpTokens).values({
        id: newId("stepup_token"),
        challengeId: challenge.id,
        tokenHash,
        createdAt: now,
        expiresAt: tokenExpiresAt
      }).run();
    });
    tx();

    const event = appendEvent(this.db, this.sqlite, {
      agentId: challenge.agentId,
      userId: challenge.userId,
      type: "step_up_approved",
      payload: { quote_id: challenge.quoteId, challenge_id: challenge.id, expires_at: tokenExpiresAt }
    });
    createReceipt(this.db, {
      agentId: challenge.agentId,
      userId: challenge.userId,
      source: "policy",
      eventId: event.event_id,
      externalRef: challenge.id,
      whatHappened: "Step-up challenge approved.",
      whyChanged: "step_up_approved",
      whatHappensNext: "Use the step-up token before it expires."
    });

    return {
      ok: true,
      response: { status: "approved", step_up_token: token, expires_at: tokenExpiresAt }
    };
  }

  private validateStepUpToken(input: {
    userId: string;
    agentId: string;
    quoteId: string;
    token: string;
  }):
    | { ok: true; tokenId: string; challengeId: string }
    | { ok: false; reason: string } {
    const tokenHash = hashStepUpToken(input.token);
    const tokenRow = this.db
      .select()
      .from(stepUpTokens)
      .where(eq(stepUpTokens.tokenHash, tokenHash))
      .get() as typeof stepUpTokens.$inferSelect | undefined;
    if (!tokenRow) {
      return { ok: false, reason: "step_up_token_invalid" };
    }
    const now = nowSeconds();
    if (tokenRow.expiresAt <= now) {
      return { ok: false, reason: "step_up_token_expired" };
    }
    const challenge = this.db
      .select()
      .from(stepUpChallenges)
      .where(eq(stepUpChallenges.id, tokenRow.challengeId))
      .get() as typeof stepUpChallenges.$inferSelect | undefined;
    if (!challenge || challenge.status !== "approved") {
      return { ok: false, reason: "step_up_challenge_invalid" };
    }
    if (
      challenge.userId !== input.userId ||
      challenge.agentId !== input.agentId ||
      challenge.quoteId !== input.quoteId
    ) {
      return { ok: false, reason: "step_up_mismatch" };
    }
    return { ok: true, tokenId: tokenRow.id, challengeId: challenge.id };
  }

  async execute(input: ExecuteRequest): Promise<ExecuteResponse> {
    const quote = this.db.select().from(quotes).where(eq(quotes.quoteId, input.quote_id)).get() as
      | typeof quotes.$inferSelect
      | undefined;
    if (!quote) {
      return { status: "rejected", reason: "quote_not_found" };
    }
    if (quote.idempotencyKey !== input.idempotency_key) {
      return { status: "rejected", reason: "idempotency_mismatch" };
    }

    const existingExec = this.db
      .select()
      .from(executions)
      .where(eq(executions.quoteId, quote.quoteId))
      .get() as typeof executions.$inferSelect | undefined;
    if (existingExec) {
      return { status: "idempotent", exec_id: existingExec.execId, external_ref: existingExec.externalRef ?? undefined };
    }

    const now = nowSeconds();
    if (quote.expiresAt < now) {
      const event = appendEvent(this.db, this.sqlite, {
        agentId: quote.agentId,
        userId: quote.userId,
        type: "execution_rejected",
        payload: { reason: "quote_expired", quote_id: quote.quoteId }
      });
      createReceipt(this.db, {
        agentId: quote.agentId,
        userId: quote.userId,
        source: "policy",
        eventId: event.event_id,
        externalRef: quote.quoteId,
        whatHappened: "Execution rejected.",
        whyChanged: "quote_expired",
        whatHappensNext: "Request a new quote."
      });
      return { status: "rejected", reason: "quote_expired" };
    }

    const freshness = await this.env.getFreshness();
    if (freshness.status !== "fresh" && !input.override_freshness) {
      const event = appendEvent(this.db, this.sqlite, {
        agentId: quote.agentId,
        userId: quote.userId,
        type: "execution_rejected",
        payload: { reason: `env_${freshness.status}`, quote_id: quote.quoteId }
      });
      createReceipt(this.db, {
        agentId: quote.agentId,
        userId: quote.userId,
        source: "policy",
        eventId: event.event_id,
        externalRef: quote.quoteId,
        whatHappened: "Execution blocked by freshness gate.",
        whyChanged: `env_${freshness.status}`,
        whatHappensNext: "Retry when environment is fresh or set override_freshness."
      });
      return { status: "rejected", reason: `env_${freshness.status}` };
    }
    if (freshness.status !== "fresh" && input.override_freshness) {
      const event = appendEvent(this.db, this.sqlite, {
        agentId: quote.agentId,
        userId: quote.userId,
        type: "freshness_override",
        payload: { status: freshness.status, quote_id: quote.quoteId }
      });
      createReceipt(this.db, {
        agentId: quote.agentId,
        userId: quote.userId,
        source: "policy",
        eventId: event.event_id,
        externalRef: quote.quoteId,
        whatHappened: "Freshness override applied.",
        whyChanged: `env_${freshness.status}`,
        whatHappensNext: "Execution proceeds under override."
      });
    }

    const decision = await this.evaluateConstraints(
      {
        agentId: quote.agentId,
        userId: quote.userId,
        intent: parseJson<Record<string, unknown>>(quote.intentJson, {})
      },
      { skipFreshness: true }
    );

    if (!decision.allowed) {
      const spendPowerPayload = decision.spend_power ? { spend_power: decision.spend_power } : {};
      const factsPayload = decision.facts_snapshot ? { facts_snapshot: decision.facts_snapshot } : {};
      const event = appendEvent(this.db, this.sqlite, {
        agentId: quote.agentId,
        userId: quote.userId,
        type: "execution_rejected",
        payload: {
          reason: decision.reason ?? "rejected",
          quote_id: quote.quoteId,
          ...spendPowerPayload,
          ...factsPayload
        }
      });
      createReceipt(this.db, {
        agentId: quote.agentId,
        userId: quote.userId,
        source: "policy",
        eventId: event.event_id,
        externalRef: quote.quoteId,
        whatHappened: "Execution rejected by policy.",
        whyChanged: decision.reason ?? "rejected",
        whatHappensNext: "No state change."
      });
      return { status: "rejected", reason: decision.reason ?? "rejected" };
    }

    if (decision.requires_step_up) {
      if (!input.step_up_token) {
        const event = appendEvent(this.db, this.sqlite, {
          agentId: quote.agentId,
          userId: quote.userId,
          type: "execution_rejected",
          payload: { reason: "step_up_required", quote_id: quote.quoteId }
        });
        createReceipt(this.db, {
          agentId: quote.agentId,
          userId: quote.userId,
          source: "policy",
          eventId: event.event_id,
          externalRef: quote.quoteId,
          whatHappened: "Execution rejected: step-up required.",
          whyChanged: "step_up_required",
          whatHappensNext: "Provide a valid step_up_token."
        });
        return { status: "rejected", reason: "step_up_required" };
      }
      const validation = this.validateStepUpToken({
        userId: quote.userId,
        agentId: quote.agentId,
        quoteId: quote.quoteId,
        token: input.step_up_token
      });
      if (!validation.ok) {
        const event = appendEvent(this.db, this.sqlite, {
          agentId: quote.agentId,
          userId: quote.userId,
          type: "execution_rejected",
          payload: { reason: validation.reason, quote_id: quote.quoteId }
        });
        createReceipt(this.db, {
          agentId: quote.agentId,
          userId: quote.userId,
          source: "policy",
          eventId: event.event_id,
          externalRef: quote.quoteId,
          whatHappened: "Execution rejected: invalid step-up token.",
          whyChanged: validation.reason,
          whatHappensNext: "Request a new step-up challenge."
        });
        return { status: "rejected", reason: validation.reason };
      }

      const stepUpEvent = appendEvent(this.db, this.sqlite, {
        agentId: quote.agentId,
        userId: quote.userId,
        type: "step_up_used",
        payload: {
          quote_id: quote.quoteId,
          challenge_id: validation.challengeId,
          token_id: validation.tokenId
        }
      });
      createReceipt(this.db, {
        agentId: quote.agentId,
        userId: quote.userId,
        source: "policy",
        eventId: stepUpEvent.event_id,
        externalRef: quote.quoteId,
        whatHappened: "Step-up token accepted.",
        whyChanged: "step_up_used",
        whatHappensNext: "Execution will proceed."
      });
    }

    const policySpendPayload = decision.spend_power ? { spend_power: decision.spend_power } : {};
    const policyFactsPayload = decision.facts_snapshot ? { facts_snapshot: decision.facts_snapshot } : {};
    const policyEvent = appendEvent(this.db, this.sqlite, {
      agentId: quote.agentId,
      userId: quote.userId,
      type: "policy_recheck",
      payload: {
        allowed: true,
        intent_type: decision.intent_type,
        quote_id: quote.quoteId,
        ...policySpendPayload,
        ...policyFactsPayload
      }
    });
    createReceipt(this.db, {
      agentId: quote.agentId,
      userId: quote.userId,
      source: "policy",
      eventId: policyEvent.event_id,
      externalRef: quote.quoteId,
      whatHappened: "Policy re-check approved.",
      whyChanged: "constraints_ok",
      whatHappensNext: "Budget reservation will proceed."
    });

    const intent = parseJson<Record<string, unknown>>(quote.intentJson, {});
    if (this.env.envName === "base_usdc" && getIntentType(intent) === "usdc_transfer") {
      return this.executeBaseUsdcTransfer({
        quote,
        decision,
        intent,
        input
      });
    }

    const { baseCost, transferAmount } = this.estimateIntentCost(intent);

    const execId = newId("exec");
    let status: "applied" | "failed" = "applied";
    let externalRef = quote.quoteId;

    const tx = this.sqlite.transaction(() => {
      this.ensureDailyReset(quote.agentId, nowSeconds());
      const budget = this.db
        .select()
        .from(budgets)
        .where(eq(budgets.agentId, quote.agentId))
        .get() as typeof budgets.$inferSelect | undefined;
      if (!budget) throw new Error("budget_missing");
      const policy = this.getPolicy(quote.agentId, quote.userId);
      const dailyMax = policy.daily_limit.max_spend_cents ?? budget.dailySpendCents;
      if (budget.creditsCents < baseCost + transferAmount) throw new Error("insufficient_credits");
      if (budget.dailySpendUsedCents + baseCost > dailyMax) throw new Error("daily_limit_exceeded");

      this.db.insert(executions).values({
        execId,
        quoteId: quote.quoteId,
        userId: quote.userId,
        agentId: quote.agentId,
        status: "queued",
        externalRef: quote.quoteId,
        createdAt: now,
        updatedAt: now
      }).run();

      this.db
        .update(budgets)
        .set({
          creditsCents: budget.creditsCents - baseCost,
          dailySpendUsedCents: budget.dailySpendUsedCents + baseCost,
          updatedAt: now
        })
        .where(eq(budgets.agentId, quote.agentId))
        .run();

      refreshAgentSpendSnapshot({
        db: this.db,
        sqlite: this.sqlite,
        config: this.config,
        agentId: quote.agentId
      });

      const reserveEvent = appendEvent(this.db, this.sqlite, {
        agentId: quote.agentId,
        userId: quote.userId,
        type: "budget_reserved",
        payload: { amount_cents: baseCost, intent_type: decision.intent_type }
      });
      createReceipt(this.db, {
        agentId: quote.agentId,
        userId: quote.userId,
        source: "execution",
        eventId: reserveEvent.event_id,
        externalRef: quote.quoteId,
        whatHappened: "Budget reserved for execution.",
        whyChanged: "reserve",
        whatHappensNext: "Environment action will apply."
      });

      const envIntent = { ...intent, __external_ref: quote.quoteId };
      const envResult = this.env.applyAction(quote.agentId, envIntent);
      externalRef = envResult.external_ref ?? quote.quoteId;

      const envEvent = appendEvent(this.db, this.sqlite, {
        agentId: quote.agentId,
        userId: quote.userId,
        type: "env_action",
        payload: { intent, ok: envResult.ok, env_events: envResult.envEvents }
      });
      createReceipt(this.db, {
        agentId: quote.agentId,
        userId: quote.userId,
        source: "env",
        eventId: envEvent.event_id,
        externalRef: externalRef,
        whatHappened: envResult.ok ? "Environment applied action." : "Environment rejected action.",
        whyChanged: envResult.ok ? "applied" : "failed",
        whatHappensNext: envResult.ok ? "Execution will finalize." : "Execution will fail."
      });

      if (!envResult.ok) {
        status = "failed";
      }

      let budgetDelta = 0;
      for (const envEv of envResult.envEvents) {
        if (envEv.cost_delta_cents) {
          budgetDelta += envEv.cost_delta_cents;
        }
        if (envEv.transfer) {
          const targetBudget = this.db
            .select()
            .from(budgets)
            .where(eq(budgets.agentId, envEv.transfer.to_agent_id))
            .get() as typeof budgets.$inferSelect | undefined;
          if (!targetBudget) throw new Error("transfer_target_budget_missing");
          if (budget.creditsCents - baseCost - budgetDelta - envEv.transfer.amount_cents < 0) {
            throw new Error("transfer_insufficient_credits");
          }
          this.db
            .update(budgets)
            .set({
              creditsCents: targetBudget.creditsCents + envEv.transfer.amount_cents,
              updatedAt: nowSeconds()
            })
            .where(eq(budgets.agentId, envEv.transfer.to_agent_id))
            .run();
          budgetDelta += envEv.transfer.amount_cents;
        }
      }

      if (budgetDelta !== 0) {
        const updatedBudget = this.db
          .select()
          .from(budgets)
          .where(eq(budgets.agentId, quote.agentId))
          .get() as typeof budgets.$inferSelect | undefined;
        if (!updatedBudget) throw new Error("budget_missing_after_env");
        this.db
          .update(budgets)
          .set({
            creditsCents: updatedBudget.creditsCents - budgetDelta,
            updatedAt: nowSeconds()
          })
          .where(eq(budgets.agentId, quote.agentId))
          .run();

        const repairEvent = appendEvent(this.db, this.sqlite, {
          agentId: quote.agentId,
          userId: quote.userId,
          type: "budget_adjustment",
          payload: { delta_cents: -budgetDelta }
        });
        createReceipt(this.db, {
          agentId: quote.agentId,
          userId: quote.userId,
          source: "repair",
          eventId: repairEvent.event_id,
          externalRef: externalRef,
          whatHappened: "Budget adjusted after environment result.",
          whyChanged: "env_adjustment",
          whatHappensNext: "Credits updated."
        });
      }

      const finalBudget = this.db
        .select()
        .from(budgets)
        .where(eq(budgets.agentId, quote.agentId))
        .get() as typeof budgets.$inferSelect | undefined;
      if (finalBudget && finalBudget.creditsCents <= 0) {
        this.db
          .update(agents)
          .set({ status: "dead", updatedAt: nowSeconds() })
          .where(eq(agents.agentId, quote.agentId))
          .run();
        const deathEvent = appendEvent(this.db, this.sqlite, {
          agentId: quote.agentId,
          userId: quote.userId,
          type: "agent_dead",
          payload: { credits_cents: finalBudget.creditsCents }
        });
        createReceipt(this.db, {
          agentId: quote.agentId,
          userId: quote.userId,
          source: "execution",
          eventId: deathEvent.event_id,
          externalRef: externalRef,
          whatHappened: "Agent marked dead.",
          whyChanged: "credits_depleted",
          whatHappensNext: "No further actions allowed."
        });
      }

      this.db
        .update(executions)
        .set({ status, updatedAt: nowSeconds() })
        .where(eq(executions.execId, execId))
        .run();

      const finalEvent = appendEvent(this.db, this.sqlite, {
        agentId: quote.agentId,
        userId: quote.userId,
        type: status === "applied" ? "execution_applied" : "execution_failed",
        payload: { quote_id: quote.quoteId, exec_id: execId }
      });
      createReceipt(this.db, {
        agentId: quote.agentId,
        userId: quote.userId,
        source: "execution",
        eventId: finalEvent.event_id,
        externalRef: externalRef,
        whatHappened: status === "applied" ? "Execution applied." : "Execution failed.",
        whyChanged: status,
        whatHappensNext: status === "applied" ? "Observation will reflect changes." : "Review env receipts."
      });
    });

    try {
      tx();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "execution_error";
      const event = appendEvent(this.db, this.sqlite, {
        agentId: quote.agentId,
        userId: quote.userId,
        type: "execution_failed",
        payload: { reason, quote_id: quote.quoteId }
      });
      createReceipt(this.db, {
        agentId: quote.agentId,
        userId: quote.userId,
        source: "execution",
        eventId: event.event_id,
        externalRef: quote.quoteId,
        whatHappened: "Execution failed before apply.",
        whyChanged: reason,
        whatHappensNext: "Review constraints and retry."
      });
      return { status: "failed", reason };
    }

    return { status, exec_id: execId, external_ref: externalRef };
  }

  private async executeBaseUsdcTransfer(input: {
    quote: typeof quotes.$inferSelect;
    decision: ConstraintDecision;
    intent: Record<string, unknown>;
    input: ExecuteRequest;
  }): Promise<ExecuteResponse> {
    const { quote, decision, intent: rawIntent, input: execInput } = input;
    const normalized = normalizeUsdcTransferIntent(rawIntent);
    if (!normalized.ok) {
      const event = appendEvent(this.db, this.sqlite, {
        agentId: quote.agentId,
        userId: quote.userId,
        type: "execution_rejected",
        payload: { reason: normalized.reason, quote_id: quote.quoteId }
      });
      createReceipt(this.db, {
        agentId: quote.agentId,
        userId: quote.userId,
        source: "policy",
        eventId: event.event_id,
        externalRef: quote.quoteId,
        whatHappened: "Execution rejected: invalid intent.",
        whyChanged: normalized.reason,
        whatHappensNext: "Request a new quote."
      });
      return { status: "rejected", reason: normalized.reason };
    }

    if (!(this.env instanceof BaseUsdcWorld)) {
      return { status: "failed", reason: "env_not_base_usdc" };
    }

    const intent = normalized.intent;
    const amountCents = Number(intent.amount_cents ?? 0);
    const toAddress = intent.to_address as `0x${string}`;

    const { baseCost, transferAmount } = this.estimateIntentCost(intent);
    const execId = newId("exec");
    const recordRef = quote.quoteId;
    let status: "applied" | "failed" = "applied";
    let externalRef = quote.quoteId;

    const reserveTx = this.sqlite.transaction(() => {
      this.ensureDailyReset(quote.agentId, nowSeconds());
      const budget = this.db
        .select()
        .from(budgets)
        .where(eq(budgets.agentId, quote.agentId))
        .get() as typeof budgets.$inferSelect | undefined;
      if (!budget) throw new Error("budget_missing");
      const policy = this.getPolicy(quote.agentId, quote.userId);
      const dailyMax = policy.daily_limit.max_spend_cents ?? budget.dailySpendCents;
      if (budget.creditsCents < baseCost + transferAmount) throw new Error("insufficient_credits");
      if (budget.dailySpendUsedCents + baseCost > dailyMax) throw new Error("daily_limit_exceeded");

      this.db.insert(executions).values({
        execId,
        quoteId: quote.quoteId,
        userId: quote.userId,
        agentId: quote.agentId,
        status: "queued",
        externalRef: quote.quoteId,
        createdAt: nowSeconds(),
        updatedAt: nowSeconds()
      }).run();

      this.db
        .update(budgets)
        .set({
          creditsCents: budget.creditsCents - baseCost,
          dailySpendUsedCents: budget.dailySpendUsedCents + baseCost,
          updatedAt: nowSeconds()
        })
        .where(eq(budgets.agentId, quote.agentId))
        .run();

      const reserveEvent = appendEvent(this.db, this.sqlite, {
        agentId: quote.agentId,
        userId: quote.userId,
        type: "budget_reserved",
        payload: { amount_cents: baseCost, intent_type: "usdc_transfer" }
      });
      createReceipt(this.db, {
        agentId: quote.agentId,
        userId: quote.userId,
        source: "execution",
        eventId: reserveEvent.event_id,
        externalRef: quote.quoteId,
        whatHappened: "Budget reserved for execution.",
        whyChanged: "reserve",
        whatHappensNext: "Environment action will apply."
      });
    });

    try {
      reserveTx();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "execution_error";
      const event = appendEvent(this.db, this.sqlite, {
        agentId: quote.agentId,
        userId: quote.userId,
        type: "execution_failed",
        payload: { reason, quote_id: quote.quoteId }
      });
      createReceipt(this.db, {
        agentId: quote.agentId,
        userId: quote.userId,
        source: "execution",
        eventId: event.event_id,
        externalRef: quote.quoteId,
        whatHappened: "Execution failed before apply.",
        whyChanged: reason,
        whatHappensNext: "Review constraints and retry."
      });
      return { status: "failed", reason };
    }

    let envResult: EnvResult;
    let txHash: string | null = null;
    let errorMessage: string | null = null;
    try {
      const hasGas = await this.hasSufficientGas(quote.agentId);
      if (!hasGas) {
        throw new Error("insufficient_gas");
      }
      const transfer = await this.env.sendUsdcTransfer(quote.agentId, toAddress, amountCents);
      txHash = transfer.txHash;
      externalRef = transfer.txHash;
      const spend = decision.spend_power;
      envResult = {
        ok: true,
        envEvents: [
          {
            type: "usdc_transfer_pending",
            payload: {
              agent_id: quote.agentId,
              to_address: toAddress,
              amount_cents: amountCents,
              tx_hash: txHash,
              observed_block_number: spend?.observed_block_number,
              observed_block_timestamp: spend?.observed_block_timestamp,
              effective_spend_power_cents: spend?.effective_spend_power_cents
            },
            cost_delta_cents: amountCents
          }
        ],
        external_ref: txHash
      };
    } catch (error) {
      status = "failed";
      errorMessage = error instanceof Error ? error.message : "transfer_failed";
      envResult = {
        ok: false,
        envEvents: [
          {
            type: "usdc_transfer_failed",
            payload: {
              agent_id: quote.agentId,
              to_address: toAddress,
              amount_cents: amountCents,
              error: errorMessage
            }
          }
        ]
      };
    }

    const finalizeTx = this.sqlite.transaction(() => {
      const now = nowSeconds();
      if (envResult.ok && txHash) {
        this.db.insert(baseUsdcPendingTxs).values({
          id: newId("usdc_tx"),
          agentId: quote.agentId,
          quoteId: quote.quoteId,
          idempotencyKey: execInput.idempotency_key,
          toAddress,
          amountCents,
          txHash,
          status: "pending",
          createdAt: now,
          updatedAt: now
        }).run();
        refreshAgentSpendSnapshot({
          db: this.db,
          sqlite: this.sqlite,
          config: this.config,
          agentId: quote.agentId
        });
      }

      const resultPayload = {
        ok: envResult.ok,
        status: envResult.ok ? "pending" : "failed",
        tx_hash: txHash,
        amount_cents: amountCents,
        to_address: toAddress
      };

      const existingDedup = this.db
        .select()
        .from(baseUsdcActionDedup)
        .where(
          and(
            eq(baseUsdcActionDedup.agentId, quote.agentId),
            eq(baseUsdcActionDedup.idempotencyKey, execInput.idempotency_key)
          )
        )
        .get() as typeof baseUsdcActionDedup.$inferSelect | undefined;
      if (!existingDedup) {
        this.db.insert(baseUsdcActionDedup).values({
          agentId: quote.agentId,
          idempotencyKey: execInput.idempotency_key,
          quoteId: quote.quoteId,
          intentJson: intent,
          resultJson: resultPayload,
          txHash: txHash ?? null,
          createdAt: now
        }).run();
      } else {
        this.db
          .update(baseUsdcActionDedup)
          .set({
            quoteId: quote.quoteId,
            intentJson: intent,
            resultJson: resultPayload,
            txHash: txHash ?? null
          })
          .where(
            and(
              eq(baseUsdcActionDedup.agentId, quote.agentId),
              eq(baseUsdcActionDedup.idempotencyKey, execInput.idempotency_key)
            )
          )
          .run();
      }

      const envEvent = appendEvent(this.db, this.sqlite, {
        agentId: quote.agentId,
        userId: quote.userId,
        type: "env_action",
        payload: {
          intent,
          ok: envResult.ok,
          env_events: envResult.envEvents,
          tx_hash: txHash,
          spend_power: decision.spend_power
        }
      });
      const spend = decision.spend_power;
      const snapshotDetails = spend
        ? `observed_block_number=${spend.observed_block_number ?? "unknown"} observed_block_timestamp=${spend.observed_block_timestamp ?? "unknown"} effective_spend_power_cents=${spend.effective_spend_power_cents ?? "unknown"}`
        : "observation_unknown";
      const whatHappened = envResult.ok
        ? `USDC transfer broadcast. tx_hash=${txHash} amount_cents=${amountCents} to_address=${toAddress} ${snapshotDetails}`
        : `USDC transfer failed. reason=${errorMessage ?? "transfer_failed"} amount_cents=${amountCents} to_address=${toAddress} ${snapshotDetails}`;
      createReceipt(this.db, {
        agentId: quote.agentId,
        userId: quote.userId,
        source: "env",
        eventId: envEvent.event_id,
        externalRef: recordRef,
        whatHappened,
        whyChanged: envResult.ok ? "applied" : "failed",
        whatHappensNext: envResult.ok ? "Pending confirmation." : "Review transfer details."
      });

      let budgetDelta = 0;
      for (const envEv of envResult.envEvents) {
        if (envEv.cost_delta_cents) {
          budgetDelta += envEv.cost_delta_cents;
        }
        if (envEv.transfer) {
          const targetBudget = this.db
            .select()
            .from(budgets)
            .where(eq(budgets.agentId, envEv.transfer.to_agent_id))
            .get() as typeof budgets.$inferSelect | undefined;
          if (!targetBudget) throw new Error("transfer_target_budget_missing");
          if (budgetDelta + envEv.transfer.amount_cents < 0) {
            throw new Error("transfer_insufficient_credits");
          }
          this.db
            .update(budgets)
            .set({
              creditsCents: targetBudget.creditsCents + envEv.transfer.amount_cents,
              updatedAt: nowSeconds()
            })
            .where(eq(budgets.agentId, envEv.transfer.to_agent_id))
            .run();
          budgetDelta += envEv.transfer.amount_cents;
        }
      }

      if (budgetDelta !== 0) {
        const updatedBudget = this.db
          .select()
          .from(budgets)
          .where(eq(budgets.agentId, quote.agentId))
          .get() as typeof budgets.$inferSelect | undefined;
        if (!updatedBudget) throw new Error("budget_missing_after_env");
        this.db
          .update(budgets)
          .set({
            creditsCents: updatedBudget.creditsCents - budgetDelta,
            updatedAt: nowSeconds()
          })
          .where(eq(budgets.agentId, quote.agentId))
          .run();

        const repairEvent = appendEvent(this.db, this.sqlite, {
          agentId: quote.agentId,
          userId: quote.userId,
          type: "budget_adjustment",
          payload: { delta_cents: -budgetDelta }
        });
        createReceipt(this.db, {
          agentId: quote.agentId,
          userId: quote.userId,
          source: "repair",
          eventId: repairEvent.event_id,
          externalRef: recordRef,
          whatHappened: "Budget adjusted after environment result.",
          whyChanged: "env_adjustment",
          whatHappensNext: "Credits updated."
        });
      }

      const finalBudget = this.db
        .select()
        .from(budgets)
        .where(eq(budgets.agentId, quote.agentId))
        .get() as typeof budgets.$inferSelect | undefined;
      if (finalBudget && finalBudget.creditsCents <= 0) {
        this.db
          .update(agents)
          .set({ status: "dead", updatedAt: nowSeconds() })
          .where(eq(agents.agentId, quote.agentId))
          .run();
        const deathEvent = appendEvent(this.db, this.sqlite, {
          agentId: quote.agentId,
          userId: quote.userId,
          type: "agent_dead",
          payload: { credits_cents: finalBudget.creditsCents }
        });
        createReceipt(this.db, {
          agentId: quote.agentId,
          userId: quote.userId,
          source: "execution",
          eventId: deathEvent.event_id,
          externalRef: recordRef,
          whatHappened: "Agent marked dead.",
          whyChanged: "credits_depleted",
          whatHappensNext: "No further actions allowed."
        });
      }

      this.db
        .update(executions)
        .set({ status, updatedAt: nowSeconds() })
        .where(eq(executions.execId, execId))
        .run();

      const finalEvent = appendEvent(this.db, this.sqlite, {
        agentId: quote.agentId,
        userId: quote.userId,
        type: status === "applied" ? "execution_applied" : "execution_failed",
        payload: { quote_id: quote.quoteId, exec_id: execId }
      });
      createReceipt(this.db, {
        agentId: quote.agentId,
        userId: quote.userId,
        source: "execution",
        eventId: finalEvent.event_id,
        externalRef: recordRef,
        whatHappened: status === "applied" ? "Execution applied." : "Execution failed.",
        whyChanged: status,
        whatHappensNext: status === "applied" ? "Observation will reflect changes." : "Review env receipts."
      });
    });

    try {
      finalizeTx();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "execution_error";
      const event = appendEvent(this.db, this.sqlite, {
        agentId: quote.agentId,
        userId: quote.userId,
        type: "execution_failed",
        payload: { reason, quote_id: quote.quoteId }
      });
      createReceipt(this.db, {
        agentId: quote.agentId,
        userId: quote.userId,
        source: "execution",
        eventId: event.event_id,
        externalRef: quote.quoteId,
        whatHappened: "Execution failed before apply.",
        whyChanged: reason,
        whatHappensNext: "Review constraints and retry."
      });
      return { status: "failed", reason };
    }

    return { status, exec_id: execId, external_ref: externalRef };
  }

  async getState(agentId: string) {
    const agent = this.db.select().from(agents).where(eq(agents.agentId, agentId)).get() as
      | typeof agents.$inferSelect
      | undefined;
    if (!agent) return { agent_id: agentId, status: "unknown" };
    const observation = await this.env.getObservation(agentId);
    const freshness = await this.env.getFreshness();
    let spendPower: SpendPowerSnapshot | undefined;
    if (this.env.envName === "base_usdc") {
      const budget = this.db
        .select()
        .from(budgets)
        .where(eq(budgets.agentId, agentId))
        .get() as typeof budgets.$inferSelect | undefined;
      if (budget) {
        const policy = this.getPolicy(agentId, agent.userId);
        const { policySpendableCents } = this.computePolicySpendable(budget, policy, 0);
        const snapshot = this.extractUsdcObservationSnapshot(observation as Record<string, unknown>);
        if (snapshot) {
          const reservedOutgoingCents = this.getReservedOutgoingCents(agentId);
          const reservedHoldsCents = this.getReservedHoldCents(agentId);
          const confirmedSpendableCents =
            snapshot.confirmed_balance_cents -
            reservedOutgoingCents -
            reservedHoldsCents -
            this.config.USDC_BUFFER_CENTS;
          spendPower = {
            policy_spendable_cents: policySpendableCents,
            effective_spend_power_cents: Math.min(policySpendableCents, confirmedSpendableCents),
            confirmed_balance_cents: snapshot.confirmed_balance_cents,
            reserved_outgoing_cents: reservedOutgoingCents,
            reserved_holds_cents: reservedHoldsCents,
            buffer_cents: snapshot.buffer_cents,
            confirmed_usdc_spendable_cents: confirmedSpendableCents,
            observed_block_number: snapshot.observed_block_number,
            observed_block_timestamp: snapshot.observed_block_timestamp
          };
        } else {
          spendPower = {
            policy_spendable_cents: policySpendableCents,
            effective_spend_power_cents: policySpendableCents
          };
        }
      }
    }

    return {
      agent_id: agentId,
      status: agent.status,
      observation,
      env_freshness: freshness,
      ...(spendPower ? { spend_power: spendPower } : {})
    };
  }

  getAgentSummary(agentId: string, windowSeconds: number) {
    const now = nowSeconds();
    const window = Math.max(0, windowSeconds);
    const since = window > 0 ? now - window : 0;
    const snapshot =
      refreshAgentSpendSnapshot({
        db: this.db,
        sqlite: this.sqlite,
        config: this.config,
        agentId
      }) ??
      (this.db
        .select()
        .from(agentSpendSnapshot)
        .where(eq(agentSpendSnapshot.agentId, agentId))
        .get() as typeof agentSpendSnapshot.$inferSelect | undefined);

    const totalRow = this.sqlite
      .prepare(
        "SELECT COALESCE(SUM(amount_cents), 0) as total FROM base_usdc_pending_txs WHERE agent_id = ? AND status IN ('pending','confirmed') AND created_at >= ?"
      )
      .get(agentId, since) as { total?: number } | undefined;
    const totalSpentCents = totalRow?.total ?? 0;

    const receiptsRows = this.db
      .select()
      .from(receipts)
      .where(since ? and(eq(receipts.agentId, agentId), gt(receipts.createdAt, since)) : eq(receipts.agentId, agentId))
      .orderBy(desc(receipts.createdAt))
      .limit(10)
      .all();

    return {
      total_spent_cents: totalSpentCents,
      confirmed_balance_cents: snapshot?.confirmedBalanceCents ?? 0,
      reserved_outgoing_cents: snapshot?.reservedOutgoingCents ?? 0,
      effective_spend_power_cents: snapshot?.effectiveSpendPowerCents ?? 0,
      last_receipts: receiptsRows
    };
  }

  getAgentTimeline(agentId: string, since?: number, limit?: number) {
    const max = Math.max(1, limit ?? 50);
    const receiptRows = this.db
      .select()
      .from(receipts)
      .where(
        since
          ? and(eq(receipts.agentId, agentId), gt(receipts.occurredAt, since))
          : eq(receipts.agentId, agentId)
      )
      .orderBy(desc(receipts.occurredAt))
      .limit(max)
      .all();

    const eventRows = this.db
      .select()
      .from(events)
      .where(
        since ? and(eq(events.agentId, agentId), gt(events.occurredAt, since)) : eq(events.agentId, agentId)
      )
      .orderBy(desc(events.occurredAt))
      .limit(max)
      .all();

    const combined = [
      ...receiptRows.map((row) => ({
        id: row.receiptId,
        ts: row.occurredAt,
        kind: "receipt" as const,
        type: row.source,
        what_happened: row.whatHappened,
        why_changed: row.whyChanged,
        what_happens_next: row.whatHappensNext,
        event_id: row.eventId,
        external_ref: row.externalRef
      })),
      ...eventRows.map((row) => ({
        id: row.eventId,
        ts: row.occurredAt,
        kind: "event" as const,
        type: row.type,
        payload: parseJson<Record<string, unknown>>(row.payloadJson, {})
      }))
    ];

    combined.sort((a, b) => {
      if (b.ts !== a.ts) return b.ts - a.ts;
      return a.id.localeCompare(b.id);
    });

    return combined.slice(0, max);
  }

  getReceiptWithFacts(agentId: string, receiptId: string) {
    const receipt = this.db
      .select()
      .from(receipts)
      .where(eq(receipts.receiptId, receiptId))
      .get() as typeof receipts.$inferSelect | undefined;
    if (!receipt || receipt.agentId !== agentId) return null;
    const event = receipt.eventId
      ? (this.db
          .select()
          .from(events)
          .where(eq(events.eventId, receipt.eventId))
          .get() as typeof events.$inferSelect | undefined)
      : undefined;
    const payload = event ? parseJson<Record<string, unknown>>(event.payloadJson, {}) : undefined;
    const factsSnapshot = payload && typeof payload === "object" ? (payload as Record<string, unknown>).facts_snapshot : undefined;
    return {
      receipt,
      facts_snapshot: factsSnapshot ?? null,
      event: event
        ? {
            event_id: event.eventId,
            type: event.type,
            payload
          }
        : null
    };
  }

  getReceipts(agentId: string, since?: number) {
    const rows = this.db
      .select()
      .from(receipts)
      .where(
        since
          ? and(eq(receipts.agentId, agentId), gt(receipts.createdAt, since))
          : eq(receipts.agentId, agentId)
      )
      .orderBy(receipts.createdAt)
      .all();
    return rows;
  }

  freezeAgent(agentId: string, reason: string) {
    const agent = this.db.select().from(agents).where(eq(agents.agentId, agentId)).get() as
      | typeof agents.$inferSelect
      | undefined;
    if (!agent) return { ok: false, reason: "agent_not_found" };
    const now = nowSeconds();
    this.db
      .update(agents)
      .set({ status: "frozen", updatedAt: now })
      .where(eq(agents.agentId, agentId))
      .run();
    const event = appendEvent(this.db, this.sqlite, {
      agentId,
      userId: agent.userId,
      type: "agent_frozen",
      payload: { reason }
    });
    createReceipt(this.db, {
      agentId,
      userId: agent.userId,
      source: "policy",
      eventId: event.event_id,
      whatHappened: "Agent frozen.",
      whyChanged: reason,
      whatHappensNext: "No further actions until unfrozen."
    });
    return { ok: true };
  }

  revokeToken(tokenId: string) {
    const token = this.db
      .select()
      .from(agentTokens)
      .where(eq(agentTokens.tokenId, tokenId))
      .get() as typeof agentTokens.$inferSelect | undefined;
    if (!token) return { ok: false, reason: "token_not_found" };
    const now = nowSeconds();
    this.db
      .update(agentTokens)
      .set({ status: "revoked", revokedAt: now })
      .where(eq(agentTokens.tokenId, tokenId))
      .run();
    const event = appendEvent(this.db, this.sqlite, {
      agentId: token.agentId,
      userId: token.userId,
      type: "token_revoked",
      payload: { token_id: tokenId }
    });
    createReceipt(this.db, {
      agentId: token.agentId,
      userId: token.userId,
      source: "policy",
      eventId: event.event_id,
      whatHappened: "Token revoked.",
      whyChanged: "manual_revoke",
      whatHappensNext: "Use another token."
    });
    return { ok: true };
  }
}
