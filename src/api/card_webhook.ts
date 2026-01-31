import { createHmac, timingSafeEqual } from "node:crypto";

export const CARD_SIGNATURE_HEADER = "x-card-signature";
export const CARD_TIMESTAMP_HEADER = "x-card-timestamp";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = canonicalize(obj[key]);
    }
    return result;
  }
  return value;
}

export function canonicalizeBody(body: unknown): string {
  return JSON.stringify(canonicalize(body));
}

export function computeCardSignature(input: {
  secret: string;
  timestamp: string | number;
  body: unknown;
}) {
  const timestamp = String(input.timestamp);
  const payload = `${timestamp}.${canonicalizeBody(input.body)}`;
  return createHmac("sha256", input.secret).update(payload).digest("hex");
}

export function verifyCardSignature(input: {
  secret: string;
  signature: string;
  timestamp: string;
  body: unknown;
  now: number;
  toleranceSeconds?: number;
}): { ok: true } | { ok: false; reason: string } {
  const trimmedSignature = input.signature.trim();
  const trimmedTimestamp = input.timestamp.trim();
  if (!trimmedSignature) return { ok: false, reason: "missing_signature" };
  if (!trimmedTimestamp) return { ok: false, reason: "missing_timestamp" };

  const timestampNum = Number(trimmedTimestamp);
  if (!Number.isFinite(timestampNum)) return { ok: false, reason: "invalid_timestamp" };
  const tolerance = input.toleranceSeconds ?? 300;
  const age = Math.abs(input.now - timestampNum);
  if (age > tolerance) return { ok: false, reason: "timestamp_out_of_range" };

  const expected = computeCardSignature({
    secret: input.secret,
    timestamp: trimmedTimestamp,
    body: input.body
  });

  if (expected.length !== trimmedSignature.length) {
    return { ok: false, reason: "invalid_signature" };
  }

  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(trimmedSignature, "utf8");
  if (!timingSafeEqual(expectedBuf, actualBuf)) {
    return { ok: false, reason: "invalid_signature" };
  }

  return { ok: true };
}
