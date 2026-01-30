import { receipts } from "../db/schema.js";
import { newId, nowSeconds } from "./utils.js";
import type { DbClient } from "../db/database.js";

export type ReceiptRecord = {
  receipt_id: string;
  agent_id: string;
  user_id: string;
  source: "policy" | "execution" | "env" | "repair";
  event_id: string | null;
  external_ref: string | null;
  what_happened: string;
  why_changed: string;
  what_happens_next: string;
  occurred_at: number;
  created_at: number;
};

export function createReceipt(
  db: DbClient,
  input: {
    agentId: string;
    userId: string;
    source: "policy" | "execution" | "env" | "repair";
    eventId?: string | null;
    externalRef?: string | null;
    whatHappened: string;
    whyChanged: string;
    whatHappensNext: string;
    occurredAt?: number;
  }
): ReceiptRecord {
  const occurredAt = input.occurredAt ?? nowSeconds();
  const createdAt = nowSeconds();
  const receiptId = newId("rcpt");
  db.insert(receipts).values({
    receiptId,
    agentId: input.agentId,
    userId: input.userId,
    source: input.source,
    eventId: input.eventId ?? null,
    externalRef: input.externalRef ?? null,
    whatHappened: input.whatHappened,
    whyChanged: input.whyChanged,
    whatHappensNext: input.whatHappensNext,
    occurredAt,
    createdAt
  }).run();

  return {
    receipt_id: receiptId,
    agent_id: input.agentId,
    user_id: input.userId,
    source: input.source,
    event_id: input.eventId ?? null,
    external_ref: input.externalRef ?? null,
    what_happened: input.whatHappened,
    why_changed: input.whyChanged,
    what_happens_next: input.whatHappensNext,
    occurred_at: occurredAt,
    created_at: createdAt
  };
}
