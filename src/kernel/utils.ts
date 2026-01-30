import { createHash, randomUUID } from "node:crypto";

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function newId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function stableStringifyValue(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyValue(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const inner = keys
    .map((key) => `${JSON.stringify(key)}:${stableStringifyValue(record[key])}`)
    .join(",");
  return `{${inner}}`;
}

export function stableStringify(value: unknown): string {
  return stableStringifyValue(value);
}

export function hashEvent(input: {
  prevHash: string | null;
  agentId: string;
  userId: string;
  type: string;
  occurredAt: number;
  payload: unknown;
}): string {
  const base = {
    prev_hash: input.prevHash ?? "GENESIS",
    agent_id: input.agentId,
    user_id: input.userId,
    type: input.type,
    occurred_at: input.occurredAt,
    payload: input.payload
  };
  const data = stableStringify(base);
  return createHash("sha256").update(data).digest("hex");
}

export function dayStartEpoch(nowSecondsValue: number) {
  const date = new Date(nowSecondsValue * 1000);
  const utcYear = date.getUTCFullYear();
  const utcMonth = date.getUTCMonth();
  const utcDate = date.getUTCDate();
  const start = Date.UTC(utcYear, utcMonth, utcDate, 0, 0, 0);
  return Math.floor(start / 1000);
}
