import { describe, expect, it } from "vitest";
import { createTestContext } from "./helpers.js";
import { agents, budgets, economyJobs, economyAgentState, envHealth, executions, receipts } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { hashEvent } from "../src/kernel/utils.js";

function getSingleJob(db: ReturnType<typeof createTestContext>["db"]) {
  return db.select().from(economyJobs).where(eq(economyJobs.status, "open")).get();
}

describe("Constraint Kernel", () => {
  it("enforces receipts append-only at the DB level", async () => {
    const { sqlite, kernel } = createTestContext();
    const { agent_id } = kernel.createAgent();
    const row = sqlite
      .prepare("SELECT receipt_id FROM receipts WHERE agent_id = ? ORDER BY rowid ASC LIMIT 1")
      .get(agent_id) as { receipt_id?: string } | undefined;
    expect(row?.receipt_id).toBeTruthy();
    const receiptId = row?.receipt_id ?? "";

    expect(() => {
      sqlite
        .prepare("UPDATE receipts SET what_happened = ? WHERE receipt_id = ?")
        .run("tamper", receiptId);
    }).toThrow();
    expect(() => {
      sqlite.prepare("DELETE FROM receipts WHERE receipt_id = ?").run(receiptId);
    }).toThrow();
  });

  it("enforces events append-only at the DB level", async () => {
    const { sqlite, kernel } = createTestContext();
    const { agent_id } = kernel.createAgent();
    const row = sqlite
      .prepare("SELECT event_id FROM events WHERE agent_id = ? ORDER BY rowid ASC LIMIT 1")
      .get(agent_id) as { event_id?: string } | undefined;
    expect(row?.event_id).toBeTruthy();
    const eventId = row?.event_id ?? "";

    expect(() => {
      sqlite.prepare("UPDATE events SET type = ? WHERE event_id = ?").run("tamper", eventId);
    }).toThrow();
    expect(() => {
      sqlite.prepare("DELETE FROM events WHERE event_id = ?").run(eventId);
    }).toThrow();
  });

  it("emits an event+receipt when creating an agent", async () => {
    const { sqlite, kernel } = createTestContext();
    const eventsBefore = sqlite.prepare("SELECT COUNT(1) as count FROM events").get() as { count: number };
    const receiptsBefore = sqlite.prepare("SELECT COUNT(1) as count FROM receipts").get() as { count: number };
    const { agent_id, user_id } = kernel.createAgent();

    const eventRow = sqlite
      .prepare("SELECT * FROM events WHERE agent_id = ? AND type = ?")
      .get(agent_id, "kernel.agent_created") as { event_id?: string; payload_json?: string } | undefined;
    expect(eventRow?.event_id).toBeTruthy();
    const receiptRow = sqlite
      .prepare("SELECT * FROM receipts WHERE agent_id = ? AND event_id = ?")
      .get(agent_id, eventRow?.event_id ?? "") as { receipt_id?: string } | undefined;
    expect(receiptRow?.receipt_id).toBeTruthy();

    const payload = eventRow?.payload_json ? JSON.parse(eventRow.payload_json) : {};
    expect(payload.user_id).toBe(user_id);
    expect(payload.agent_id).toBe(agent_id);

    const eventsAfter = sqlite.prepare("SELECT COUNT(1) as count FROM events").get() as { count: number };
    const receiptsAfter = sqlite.prepare("SELECT COUNT(1) as count FROM receipts").get() as { count: number };
    expect(eventsAfter.count).toBe(eventsBefore.count + 1);
    expect(receiptsAfter.count).toBe(receiptsBefore.count + 1);
  });

  it("emits an event+receipt when daily spend counters reset", async () => {
    const { db, sqlite, kernel } = createTestContext();
    const { agent_id, user_id } = kernel.createAgent();

    db.update(budgets)
      .set({ dailySpendUsedCents: 123, lastResetAt: 0 })
      .where(eq(budgets.agentId, agent_id))
      .run();

    const before = sqlite
      .prepare("SELECT COUNT(1) as count FROM events WHERE agent_id = ? AND type = ?")
      .get(agent_id, "kernel.daily_reset") as { count: number };

    const quote = await kernel.canDo({ user_id, agent_id, intent_json: { type: "request_job" } });
    expect(quote.allowed).toBe(true);

    const after = sqlite
      .prepare("SELECT COUNT(1) as count FROM events WHERE agent_id = ? AND type = ?")
      .get(agent_id, "kernel.daily_reset") as { count: number };
    expect(after.count).toBe(before.count + 1);

    const resetEvent = sqlite
      .prepare("SELECT event_id FROM events WHERE agent_id = ? AND type = ?")
      .get(agent_id, "kernel.daily_reset") as { event_id?: string } | undefined;
    const resetReceipt = sqlite
      .prepare("SELECT receipt_id FROM receipts WHERE agent_id = ? AND event_id = ?")
      .get(agent_id, resetEvent?.event_id ?? "") as { receipt_id?: string } | undefined;
    expect(resetReceipt?.receipt_id).toBeTruthy();

    const budget = db.select().from(budgets).where(eq(budgets.agentId, agent_id)).get();
    expect(budget?.dailySpendUsedCents).toBe(0);
  });

  it("fails closed on stale/unknown freshness for can_do", async () => {
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
    expect(quote.allowed).toBe(false);
    expect(quote.reason).toMatch(/^env_/);
  });

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
