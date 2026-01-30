import { describe, expect, it } from "vitest";
import { createTestContext } from "./helpers.js";
import { agents, budgets, economyJobs, economyAgentState, envHealth, executions, receipts } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { hashEvent } from "../src/kernel/utils.js";

function getSingleJob(db: ReturnType<typeof createTestContext>["db"]) {
  return db.select().from(economyJobs).where(eq(economyJobs.status, "open")).get();
}

describe("Constraint Kernel", () => {
  it("enforces append-only audit chain and validates hashes", async () => {
    const { db, sqlite, kernel } = createTestContext();
    const { user_id, agent_id } = kernel.createAgent();
    const quote = await kernel.canDo({ user_id, agent_id, intent_json: { type: "request_job" } });
    await kernel.execute({ quote_id: quote.quote_id, idempotency_key: quote.idempotency_key });

    const eventRows = sqlite
      .prepare("SELECT * FROM events WHERE agent_id = ? ORDER BY rowid ASC")
      .all(agent_id) as Array<{
      event_id: string;
      agent_id: string;
      user_id: string;
      type: string;
      payload_json: string;
      occurred_at: number;
      created_at: number;
      hash: string;
      prev_hash: string | null;
    }>;
    let prevHash: string | null = null;
    for (const ev of eventRows) {
      expect(ev.prev_hash ?? null).toEqual(prevHash ?? null);
      const computed = hashEvent({
        prevHash: ev.prev_hash ?? null,
        agentId: ev.agent_id,
        userId: ev.user_id,
        type: ev.type,
        occurredAt: ev.occurred_at,
        payload: JSON.parse(ev.payload_json) as Record<string, unknown>
      });
      expect(computed).toEqual(ev.hash);
      prevHash = ev.hash;
    }

    expect(() => {
      sqlite.exec("UPDATE events SET type = 'tamper' WHERE 1=1");
    }).toThrow();
    expect(() => {
      sqlite.exec("DELETE FROM events WHERE 1=1");
    }).toThrow();
  });

  it("is idempotent on execute retries", async () => {
    const { db, kernel } = createTestContext();
    const { user_id, agent_id } = kernel.createAgent();
    const quote = await kernel.canDo({ user_id, agent_id, intent_json: { type: "request_job" }, idempotency_key: "q1" });
    const first = await kernel.execute({ quote_id: quote.quote_id, idempotency_key: quote.idempotency_key });
    const budgetAfter = db.select().from(budgets).where(eq(budgets.agentId, agent_id)).get();
    const second = await kernel.execute({ quote_id: quote.quote_id, idempotency_key: quote.idempotency_key });
    const budgetAfterRetry = db.select().from(budgets).where(eq(budgets.agentId, agent_id)).get();

    expect(first.status).toBe("applied");
    expect(second.status).toBe("idempotent");
    expect(budgetAfter?.creditsCents).toEqual(budgetAfterRetry?.creditsCents);
    const execRows = db.select().from(executions).where(eq(executions.quoteId, quote.quote_id)).all();
    expect(execRows.length).toBe(1);
  });

  it("blocks execute when freshness is stale/unknown unless override", async () => {
    const { db, kernel } = createTestContext({ ENV_STALE_SECONDS: 1, ENV_UNKNOWN_SECONDS: 2 });
    const { user_id, agent_id } = kernel.createAgent();
    const now = Math.floor(Date.now() / 1000);
    db.insert(envHealth).values({
      envName: "simple_economy",
      status: "unknown",
      lastOkAt: now - 500,
      lastTickAt: now - 500,
      updatedAt: now - 500
    }).run();

    const quote = await kernel.canDo({ user_id, agent_id, intent_json: { type: "request_job" } });
    const res = await kernel.execute({ quote_id: quote.quote_id, idempotency_key: quote.idempotency_key });
    expect(res.status).toBe("rejected");

    const receiptRows = db.select().from(receipts).where(eq(receipts.agentId, agent_id)).all();
    const freshnessReceipt = receiptRows.find((r) => r.whyChanged.includes("env_"));
    expect(freshnessReceipt).toBeTruthy();

    const overrideRes = await kernel.execute({
      quote_id: quote.quote_id,
      idempotency_key: quote.idempotency_key,
      override_freshness: true,
      step_up_token: "stepup"
    });
    expect(["applied", "idempotent"]).toContain(overrideRes.status);
  });

  it("marks agent dead when credits are exhausted and blocks further actions", async () => {
    const { db, kernel } = createTestContext({ DEFAULT_CREDITS_CENTS: 150 });
    const { user_id, agent_id } = kernel.createAgent();
    const quoteJob = await kernel.canDo({ user_id, agent_id, intent_json: { type: "request_job" } });
    await kernel.execute({ quote_id: quoteJob.quote_id, idempotency_key: quoteJob.idempotency_key });
    const job = getSingleJob(db);
    expect(job).toBeTruthy();

    const quoteSubmit = await kernel.canDo({
      user_id,
      agent_id,
      intent_json: { type: "submit_job", job_id: job?.jobId, answer: "wrong", confidence: 0.95 }
    });
    await kernel.execute({ quote_id: quoteSubmit.quote_id, idempotency_key: quoteSubmit.idempotency_key });

    const agent = db.select().from(agents).where(eq(agents.agentId, agent_id)).get();
    expect(agent?.status).toBe("dead");

    const quoteBlocked = await kernel.canDo({ user_id, agent_id, intent_json: { type: "request_job" } });
    expect(quoteBlocked.allowed).toBe(false);
  });

  it("enforces causal closure in observations", async () => {
    const { kernel } = createTestContext();
    const { user_id, agent_id } = kernel.createAgent();
    const before = (await kernel.getState(agent_id)).observation as { jobs?: unknown[] };
    const quote = await kernel.canDo({ user_id, agent_id, intent_json: { type: "request_job" } });
    await kernel.execute({ quote_id: quote.quote_id, idempotency_key: quote.idempotency_key });
    const after = (await kernel.getState(agent_id)).observation as { jobs?: unknown[] };
    const beforeCount = Array.isArray(before.jobs) ? before.jobs.length : 0;
    const afterCount = Array.isArray(after.jobs) ? after.jobs.length : 0;
    expect(afterCount).toBeGreaterThanOrEqual(beforeCount + 1);
  });

  it("applies calibration reward/penalty as expected", async () => {
    const { db, kernel } = createTestContext();
    const { user_id, agent_id } = kernel.createAgent();

    const quoteJob = await kernel.canDo({ user_id, agent_id, intent_json: { type: "request_job" } });
    await kernel.execute({ quote_id: quoteJob.quote_id, idempotency_key: quoteJob.idempotency_key });
    const job = getSingleJob(db);
    expect(job).toBeTruthy();

    const budgetBefore = db.select().from(budgets).where(eq(budgets.agentId, agent_id)).get();
    const quoteSubmit = await kernel.canDo({
      user_id,
      agent_id,
      intent_json: { type: "submit_job", job_id: job?.jobId, answer: job?.correctAnswer, confidence: 0.2 }
    });
    await kernel.execute({ quote_id: quoteSubmit.quote_id, idempotency_key: quoteSubmit.idempotency_key });
    const budgetAfter = db.select().from(budgets).where(eq(budgets.agentId, agent_id)).get();

    expect(budgetBefore && budgetAfter).toBeTruthy();
    const delta = (budgetAfter?.creditsCents ?? 0) - (budgetBefore?.creditsCents ?? 0);
    expect(delta).toBeGreaterThan(0);

    const state = db.select().from(economyAgentState).where(eq(economyAgentState.agentId, agent_id)).get();
    expect(state?.calibrationScore).toBeGreaterThan(0);
  });
});
