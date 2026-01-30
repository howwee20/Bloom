import { events } from "../db/schema.js";
import { hashEvent, newId, nowSeconds } from "./utils.js";
import type { DbClient } from "../db/database.js";
import type Database from "better-sqlite3";

export type EventRecord = {
  event_id: string;
  agent_id: string;
  user_id: string;
  type: string;
  payload_json: Record<string, unknown>;
  occurred_at: number;
  created_at: number;
  hash: string;
  prev_hash: string | null;
};

export function appendEvent(
  db: DbClient,
  sqlite: Database,
  input: {
    agentId: string;
    userId: string;
    type: string;
    payload: Record<string, unknown>;
    occurredAt?: number;
  }
): EventRecord {
  const occurredAt = input.occurredAt ?? nowSeconds();
  const createdAt = nowSeconds();
  const prev = sqlite
    .prepare("SELECT hash FROM events WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(input.agentId) as { hash?: string } | undefined;
  const prevHash = prev?.hash ?? null;
  const hash = hashEvent({
    prevHash,
    agentId: input.agentId,
    userId: input.userId,
    type: input.type,
    occurredAt,
    payload: input.payload
  });
  const eventId = newId("evt");
  db.insert(events).values({
    eventId,
    agentId: input.agentId,
    userId: input.userId,
    type: input.type,
    payloadJson: input.payload,
    occurredAt,
    createdAt,
    hash,
    prevHash
  }).run();

  return {
    event_id: eventId,
    agent_id: input.agentId,
    user_id: input.userId,
    type: input.type,
    payload_json: input.payload,
    occurred_at: occurredAt,
    created_at: createdAt,
    hash,
    prev_hash: prevHash
  };
}
