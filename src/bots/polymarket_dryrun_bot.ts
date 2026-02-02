import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import type { DbClient } from "../db/database.js";
import { agents } from "../db/schema.js";
import type { Config } from "../config.js";
import { appendEvent } from "../kernel/events.js";
import { createReceipt } from "../kernel/receipts.js";
import { nowSeconds } from "../kernel/utils.js";

type CandidateMarket = {
  market_slug: string;
  token_id: string;
  score: number;
  rationale: string;
};

const CANDIDATE_MARKETS: CandidateMarket[] = [
  { market_slug: "test_market_alpha", token_id: "YES_ALPHA", score: 0.78, rationale: "high volume proxy" },
  { market_slug: "test_market_beta", token_id: "YES_BETA", score: 0.55, rationale: "mid volatility proxy" },
  { market_slug: "test_market_gamma", token_id: "YES_GAMMA", score: 0.43, rationale: "low correlation proxy" }
];

function rankCandidates() {
  return [...CANDIDATE_MARKETS].sort((a, b) => b.score - a.score);
}

export type PolymarketDryrunBotStatus = {
  running: boolean;
  agent_id: string | null;
  loop_seconds: number;
  last_tick_at: number | null;
  next_tick_at: number | null;
};

export class PolymarketDryrunBot {
  private db: DbClient;
  private sqlite: Database;
  private config: Config;
  private timer: NodeJS.Timeout | null = null;
  private agentId: string | null = null;
  private lastTickAt: number | null = null;

  constructor(db: DbClient, sqlite: Database, config: Config) {
    this.db = db;
    this.sqlite = sqlite;
    this.config = config;
  }

  start(agentId: string): PolymarketDryrunBotStatus {
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId) {
      throw new Error("agent_id_required");
    }
    if (this.timer) {
      this.stop();
    }
    this.agentId = normalizedAgentId;
    this.tick();
    const loopSeconds = Math.max(1, this.config.POLY_DRYRUN_LOOP_SECONDS);
    this.timer = setInterval(() => this.tick(), loopSeconds * 1000);
    return this.status();
  }

  stop(): PolymarketDryrunBotStatus {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.agentId = null;
    return this.status();
  }

  status(): PolymarketDryrunBotStatus {
    const loopSeconds = Math.max(1, this.config.POLY_DRYRUN_LOOP_SECONDS);
    const nextTickAt = this.timer && this.lastTickAt ? this.lastTickAt + loopSeconds : null;
    return {
      running: Boolean(this.timer),
      agent_id: this.agentId,
      loop_seconds: loopSeconds,
      last_tick_at: this.lastTickAt,
      next_tick_at: nextTickAt
    };
  }

  private tick() {
    if (!this.agentId) return;
    const now = nowSeconds();
    this.lastTickAt = now;
    try {
      const ranked = rankCandidates();
      const agent = this.db.select().from(agents).where(eq(agents.agentId, this.agentId)).get() as
        | typeof agents.$inferSelect
        | undefined;
      if (!agent) {
        console.error(`[polymarket-dryrun] agent_missing=${this.agentId}`);
        return;
      }
      console.error(
        `[polymarket-dryrun] agent_id=${this.agentId} candidates=${ranked
          .map((candidate) => `${candidate.market_slug}:${candidate.score}`)
          .join(",")}`
      );

      const event = appendEvent(this.db, this.sqlite, {
        agentId: this.agentId,
        userId: agent.userId,
        type: "polymarket_bot_tick",
        payload: {
          agent_id: this.agentId,
          observe_only: true,
          candidates: ranked
        },
        occurredAt: now
      });

      createReceipt(this.db, {
        agentId: this.agentId,
        userId: agent.userId,
        source: "execution",
        eventId: event.event_id,
        externalRef: this.agentId,
        whatHappened: "Polymarket bot tick (observe-only).",
        whyChanged: "observe_only",
        whatHappensNext: "No trades executed in Phase 1.",
        occurredAt: now
      });
    } catch (error) {
      console.error(`[polymarket-dryrun] tick_failed=${error instanceof Error ? error.message : "unknown"}`);
    }
  }
}
