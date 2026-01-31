import { describe, expect, it } from "vitest";
import { createTestContext } from "./helpers.js";
import { policies, stepUpTokens, receipts } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { nowSeconds } from "../src/kernel/utils.js";

function requireStepUp(db: ReturnType<typeof createTestContext>["db"], agentId: string) {
  db.update(policies)
    .set({ stepUpThresholdJson: { spend_cents: 0 } })
    .where(eq(policies.agentId, agentId))
    .run();
}

describe("Step-up flow", () => {
  it("blocks execute without step_up_token", async () => {
    const { db, kernel } = createTestContext();
    const { user_id, agent_id } = kernel.createAgent();
    requireStepUp(db, agent_id);

    const quote = await kernel.canDo({ user_id, agent_id, intent_json: { type: "request_job" } });
    expect(quote.requires_step_up).toBe(true);

    const res = await kernel.execute({ quote_id: quote.quote_id, idempotency_key: quote.idempotency_key });
    expect(res.status).toBe("rejected");
    expect(res.reason).toBe("step_up_required");
  });

  it("rejects incorrect step-up code and approves with correct code", async () => {
    const { db, kernel } = createTestContext();
    const { user_id, agent_id } = kernel.createAgent();
    requireStepUp(db, agent_id);

    const quote = await kernel.canDo({ user_id, agent_id, intent_json: { type: "request_job" } });
    const challenge = await kernel.requestStepUpChallenge({
      user_id,
      agent_id,
      quote_id: quote.quote_id
    });

    expect(challenge.code).toBeTruthy();
    const bad = await kernel.confirmStepUpChallenge({
      challenge_id: challenge.challenge_id,
      code: "000000",
      decision: "approve"
    });
    expect(bad.ok).toBe(false);

    const good = await kernel.confirmStepUpChallenge({
      challenge_id: challenge.challenge_id,
      code: challenge.code as string,
      decision: "approve"
    });
    expect(good.ok).toBe(true);
    expect(good.ok && good.response.step_up_token).toBeTruthy();

    const exec = await kernel.execute({
      quote_id: quote.quote_id,
      idempotency_key: quote.idempotency_key,
      step_up_token: good.ok ? good.response.step_up_token : undefined
    });
    expect(["applied", "idempotent"]).toContain(exec.status);
  });

  it("token authorizes only its quote and expires", async () => {
    const { db, kernel } = createTestContext({ STEP_UP_TOKEN_TTL_SECONDS: 60 });
    const { user_id, agent_id } = kernel.createAgent();
    requireStepUp(db, agent_id);

    const quoteA = await kernel.canDo({ user_id, agent_id, intent_json: { type: "request_job" } });
    const challengeA = await kernel.requestStepUpChallenge({
      user_id,
      agent_id,
      quote_id: quoteA.quote_id
    });
    const approvalA = await kernel.confirmStepUpChallenge({
      challenge_id: challengeA.challenge_id,
      code: challengeA.code as string,
      decision: "approve"
    });
    const token = approvalA.ok ? approvalA.response.step_up_token : undefined;
    expect(token).toBeTruthy();

    const quoteB = await kernel.canDo({ user_id, agent_id, intent_json: { type: "request_job" } });
    const mismatch = await kernel.execute({
      quote_id: quoteB.quote_id,
      idempotency_key: quoteB.idempotency_key,
      step_up_token: token
    });
    expect(mismatch.status).toBe("rejected");
    expect(mismatch.reason).toBe("step_up_mismatch");

    const tokenRow = db.select().from(stepUpTokens).get();
    if (tokenRow) {
      db.update(stepUpTokens)
        .set({ expiresAt: nowSeconds() - 1 })
        .where(eq(stepUpTokens.id, tokenRow.id))
        .run();
    }

    const expired = await kernel.execute({
      quote_id: quoteA.quote_id,
      idempotency_key: quoteA.idempotency_key,
      step_up_token: token
    });
    expect(expired.status).toBe("rejected");
    expect(expired.reason).toBe("step_up_token_expired");
  });

  it("emits receipts/events for step-up actions", async () => {
    const { db, kernel, sqlite } = createTestContext();
    const { user_id, agent_id } = kernel.createAgent();
    requireStepUp(db, agent_id);

    const quote = await kernel.canDo({ user_id, agent_id, intent_json: { type: "request_job" } });
    const challenge = await kernel.requestStepUpChallenge({
      user_id,
      agent_id,
      quote_id: quote.quote_id
    });
    const approval = await kernel.confirmStepUpChallenge({
      challenge_id: challenge.challenge_id,
      code: challenge.code as string,
      decision: "approve"
    });
    await kernel.execute({
      quote_id: quote.quote_id,
      idempotency_key: quote.idempotency_key,
      step_up_token: approval.ok ? approval.response.step_up_token : undefined
    });
    const eventsRows = sqlite
      .prepare("SELECT type FROM events WHERE agent_id = ?")
      .all(agent_id) as { type: string }[];
    const eventTypes = new Set(eventsRows.map((row) => row.type));
    expect(eventTypes.has("step_up_requested")).toBe(true);
    expect(eventTypes.has("step_up_approved")).toBe(true);
    expect(eventTypes.has("step_up_used")).toBe(true);

    const receiptRows = db.select().from(receipts).where(eq(receipts.agentId, agent_id)).all();
    const receiptReasons = new Set(receiptRows.map((row) => row.whyChanged));
    expect(receiptReasons.has("step_up_requested")).toBe(true);
    expect(receiptReasons.has("step_up_approved")).toBe(true);
    expect(receiptReasons.has("step_up_used")).toBe(true);
  });
});
