import Database from "better-sqlite3";
import type { DbClient } from "../db/database.js";
import {
  economyActionDedup,
  economyAgentState,
  economyAgentTools,
  economyCompletedJobs,
  economyJobs,
  economyTools,
  envHealth,
  agents
} from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { nowSeconds } from "../kernel/utils.js";
import type { Config } from "../config.js";
import type { EnvEvent, EnvFreshness, EnvObservation, EnvResult, IEnvironment } from "./IEnvironment.js";

const ENV_NAME = "simple_economy";

function toFreshnessStatus(now: number, lastOkAt: number | null, config: Config) {
  if (!lastOkAt) return "unknown" as const;
  const age = now - lastOkAt;
  if (age <= config.ENV_STALE_SECONDS) return "fresh" as const;
  if (age <= config.ENV_UNKNOWN_SECONDS) return "stale" as const;
  return "unknown" as const;
}

export class SimpleEconomyWorld implements IEnvironment {
  envName = ENV_NAME;
  private db: DbClient;
  private sqlite: Database;
  private config: Config;

  constructor(db: DbClient, sqlite: Database, config: Config) {
    this.db = db;
    this.sqlite = sqlite;
    this.config = config;
  }

  async getFreshness(): Promise<EnvFreshness> {
    const now = nowSeconds();
    const row = this.db
      .select()
      .from(envHealth)
      .where(eq(envHealth.envName, this.envName))
      .get() as typeof envHealth.$inferSelect | undefined;

    const lastOkAt = row?.lastOkAt ?? now;
    const lastTickAt = row?.lastTickAt ?? now;
    const status = toFreshnessStatus(now, lastOkAt, this.config);

    const updatedAgo = Math.max(0, now - lastTickAt);

    if (!row) {
      this.db.insert(envHealth).values({
        envName: this.envName,
        status,
        lastOkAt,
        lastTickAt,
        updatedAt: now
      }).run();
    } else if (row.status !== status || row.updatedAt !== now || row.lastTickAt !== now) {
      this.db
        .update(envHealth)
        .set({ status, lastTickAt: now, updatedAt: now })
        .where(eq(envHealth.envName, this.envName))
        .run();
    }

    return { status, updated_ago_seconds: updatedAgo, details: `last_ok_at=${lastOkAt}` };
  }

  private touch(ok: boolean) {
    const now = nowSeconds();
    const current = this.db
      .select()
      .from(envHealth)
      .where(eq(envHealth.envName, this.envName))
      .get() as typeof envHealth.$inferSelect | undefined;
    const next = {
      envName: this.envName,
      status: current?.status ?? "unknown",
      lastOkAt: ok ? now : current?.lastOkAt ?? null,
      lastTickAt: now,
      updatedAt: now
    };
    if (!current) {
      this.db.insert(envHealth).values(next).run();
    } else {
      this.db.update(envHealth).set(next).where(eq(envHealth.envName, this.envName)).run();
    }
  }

  async getObservation(agentId: string): Promise<EnvObservation> {
    const now = nowSeconds();
    const state = this.db
      .select()
      .from(economyAgentState)
      .where(eq(economyAgentState.agentId, agentId))
      .get() as typeof economyAgentState.$inferSelect | undefined;
    if (!state) {
      this.db
        .insert(economyAgentState)
        .values({ agentId, calibrationScore: 0, lastObservationAt: now })
        .run();
    } else {
      this.db
        .update(economyAgentState)
        .set({ lastObservationAt: now })
        .where(eq(economyAgentState.agentId, agentId))
        .run();
    }

    const jobs = this.db
      .select()
      .from(economyJobs)
      .where(eq(economyJobs.status, "open"))
      .limit(5)
      .all();

    const tools = this.db.select().from(economyTools).all();
    const ownedTools = this.db
      .select()
      .from(economyAgentTools)
      .where(eq(economyAgentTools.agentId, agentId))
      .all();

    this.touch(true);

    return {
      env: this.envName,
      jobs: jobs.map((job) => ({
        job_id: job.jobId,
        prompt: job.prompt,
        price_cents: job.priceCents,
        status: job.status
      })),
      tools: tools.map((tool) => ({
        tool_id: tool.toolId,
        name: tool.name,
        price_cents: tool.priceCents
      })),
      owned_tools: ownedTools.map((tool) => tool.toolId),
      calibration_score: state?.calibrationScore ?? 0
    };
  }

  applyAction(agentId: string, intent: Record<string, unknown>): EnvResult {
    const externalRef = (intent.__external_ref ?? intent.external_ref) as string | undefined;
    if (externalRef) {
      const existing = this.db
        .select()
        .from(economyActionDedup)
        .where(eq(economyActionDedup.externalRef, externalRef))
        .get() as typeof economyActionDedup.$inferSelect | undefined;
      if (existing) {
        const raw = existing.resultJson as unknown;
        if (typeof raw === "string") return JSON.parse(raw) as EnvResult;
        return raw as EnvResult;
      }
    }

    const type = String(intent.type ?? "");
    let result: EnvResult;
    switch (type) {
      case "request_job":
        result = this.handleRequestJob(agentId);
        break;
      case "submit_job":
        result = this.handleSubmitJob(agentId, intent);
        break;
      case "buy_tool":
        result = this.handleBuyTool(agentId, intent);
        break;
      case "send_credits":
        result = this.handleSendCredits(agentId, intent);
        break;
      default:
        result = { ok: false, envEvents: [{ type: "unknown_intent", payload: { type } }] };
        break;
    }

    if (externalRef) {
      this.db.insert(economyActionDedup).values({
        externalRef,
        agentId,
        intentJson: intent,
        resultJson: result,
        createdAt: nowSeconds()
      }).run();
      result.external_ref = externalRef;
    }

    this.touch(result.ok);
    return result;
  }

  private handleRequestJob(agentId: string): EnvResult {
    const now = nowSeconds();
    let job = this.db
      .select()
      .from(economyJobs)
      .where(eq(economyJobs.status, "open"))
      .get() as typeof economyJobs.$inferSelect | undefined;

    if (!job) {
      const countRow = this.sqlite
        .prepare("SELECT COUNT(1) as count FROM economy_jobs")
        .get() as { count?: number } | undefined;
      const seed = (countRow?.count ?? 0) + 1;
      const base = 100 + seed * 5;
      const prompt = `Compute ${seed} + ${seed + 3}`;
      const answer = String(seed + seed + 3);
      const inserted = this.db
        .insert(economyJobs)
        .values({
          prompt,
          correctAnswer: answer,
          priceCents: base,
          status: "open",
          createdAt: now,
          updatedAt: now
        })
        .run();
      job = {
        jobId: Number(inserted.lastInsertRowid),
        prompt,
        correctAnswer: answer,
        priceCents: base,
        status: "open",
        createdAt: now,
        updatedAt: now
      } as typeof economyJobs.$inferSelect;
    }

    const event: EnvEvent = {
      type: "job_assigned",
      payload: { agent_id: agentId, job_id: job.jobId, prompt: job.prompt, price_cents: job.priceCents }
    };
    return { ok: true, envEvents: [event] };
  }

  private handleSubmitJob(agentId: string, intent: Record<string, unknown>): EnvResult {
    const jobIdValue = Number(intent.job_id);
    const answer = String(intent.answer ?? "");
    const confidence = Math.max(0, Math.min(1, Number(intent.confidence ?? 0)));

    const job = this.db
      .select()
      .from(economyJobs)
      .where(eq(economyJobs.jobId, jobIdValue))
      .get() as typeof economyJobs.$inferSelect | undefined;

    if (!job || job.status !== "open") {
      return {
        ok: false,
        envEvents: [{ type: "job_missing", payload: { agent_id: agentId, job_id: jobIdValue } }]
      };
    }

    const normalizedAnswer = answer.trim();
    const correct = normalizedAnswer === job.correctAnswer.trim();
    let rewardCents = 0;
    if (correct) {
      rewardCents = confidence >= 0.8 ? job.priceCents : Math.floor(job.priceCents * 0.5);
    } else {
      rewardCents = confidence >= 0.8 ? -Math.floor(job.priceCents * 1.5) : -job.priceCents;
    }

    const now = nowSeconds();
    this.db
      .update(economyJobs)
      .set({ status: "completed", updatedAt: now })
      .where(eq(economyJobs.jobId, jobIdValue))
      .run();

    this.db
      .insert(economyCompletedJobs)
      .values({
        jobId: jobIdValue,
        agentId,
        answer: normalizedAnswer,
        confidence,
        correct: correct ? 1 : 0,
        rewardCents,
        completedAt: now
      })
      .run();

    const state = this.db
      .select()
      .from(economyAgentState)
      .where(eq(economyAgentState.agentId, agentId))
      .get() as typeof economyAgentState.$inferSelect | undefined;
    const prevScore = state?.calibrationScore ?? 0;
    const delta = correct ? (confidence >= 0.8 ? 2 : 1) : confidence >= 0.8 ? -3 : -1;
    const nextScore = prevScore + delta;
    if (!state) {
      this.db
        .insert(economyAgentState)
        .values({ agentId, calibrationScore: nextScore, lastObservationAt: now })
        .run();
    } else {
      this.db
        .update(economyAgentState)
        .set({ calibrationScore: nextScore, lastObservationAt: now })
        .where(eq(economyAgentState.agentId, agentId))
        .run();
    }

    const events: EnvEvent[] = [
      {
        type: "job_completed",
        payload: {
          agent_id: agentId,
          job_id: jobIdValue,
          correct,
          confidence,
          reward_cents: rewardCents
        },
        cost_delta_cents: -rewardCents
      },
      {
        type: "calibration_update",
        payload: { agent_id: agentId, prev_score: prevScore, next_score: nextScore }
      }
    ];

    return { ok: true, envEvents: events };
  }

  private handleBuyTool(agentId: string, intent: Record<string, unknown>): EnvResult {
    const toolId = String(intent.tool_id ?? "");
    const tool = this.db
      .select()
      .from(economyTools)
      .where(eq(economyTools.toolId, toolId))
      .get() as typeof economyTools.$inferSelect | undefined;
    if (!tool) {
      return { ok: false, envEvents: [{ type: "tool_missing", payload: { tool_id: toolId } }] };
    }

    const existing = this.db
      .select()
      .from(economyAgentTools)
      .where(and(eq(economyAgentTools.agentId, agentId), eq(economyAgentTools.toolId, toolId)))
      .get() as typeof economyAgentTools.$inferSelect | undefined;

    if (!existing) {
      this.db
        .insert(economyAgentTools)
        .values({ agentId, toolId, acquiredAt: nowSeconds() })
        .run();
    }

    return {
      ok: true,
      envEvents: [
        {
          type: existing ? "tool_already_owned" : "tool_acquired",
          payload: { agent_id: agentId, tool_id: toolId, price_cents: tool.priceCents }
        }
      ]
    };
  }

  private handleSendCredits(agentId: string, intent: Record<string, unknown>): EnvResult {
    const toAgentId = String(intent.to_agent_id ?? "");
    const amountCents = Math.max(0, Number(intent.amount_cents ?? 0));

    if (!toAgentId || amountCents <= 0) {
      return {
        ok: false,
        envEvents: [{ type: "transfer_invalid", payload: { to_agent_id: toAgentId, amount_cents: amountCents } }]
      };
    }

    const target = this.db
      .select()
      .from(agents)
      .where(eq(agents.agentId, toAgentId))
      .get();
    if (!target) {
      return {
        ok: false,
        envEvents: [{ type: "transfer_missing_agent", payload: { to_agent_id: toAgentId } }]
      };
    }

    return {
      ok: true,
      envEvents: [
        {
          type: "credits_sent",
          payload: { from_agent_id: agentId, to_agent_id: toAgentId, amount_cents: amountCents },
          transfer: { to_agent_id: toAgentId, amount_cents: amountCents }
        }
      ]
    };
  }
}
