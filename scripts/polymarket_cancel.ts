#!/usr/bin/env tsx
import "dotenv/config";

type JsonValue = Record<string, unknown>;

type HttpResult = {
  ok: boolean;
  status: number;
  data: JsonValue;
  raw: string;
};

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const baseUrl = (process.env.BLOOM_BASE_URL ?? `http://localhost:${process.env.PORT ?? "3000"}`).replace(/\/+$/, "");
const proposeKey = process.env.BLOOM_PROPOSE_KEY ?? "";
const executeKey = process.env.BLOOM_EXECUTE_KEY ?? proposeKey;

if (!proposeKey) {
  console.error("BLOOM_PROPOSE_KEY missing");
  process.exit(1);
}

if (!executeKey) {
  console.error("BLOOM_EXECUTE_KEY missing (or set BLOOM_PROPOSE_KEY with execute scope)");
  process.exit(1);
}

const agentId = arg("--agent");
const orderId = arg("--order_id") ?? arg("--order");

if (!agentId) {
  console.error("--agent required");
  process.exit(1);
}

if (!orderId) {
  console.error("--order_id required");
  process.exit(1);
}

async function fetchJson(path: string, key: string, body: unknown): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key
    },
    body: JSON.stringify(body)
  });

  const raw = await response.text();
  let data: JsonValue = {};
  if (raw) {
    try {
      data = JSON.parse(raw) as JsonValue;
    } catch {
      data = { error: raw };
    }
  }

  return { ok: response.ok, status: response.status, data, raw };
}

async function postOrExit(path: string, key: string, body: unknown) {
  const result = await fetchJson(path, key, body);
  if (!result.ok) {
    const error = (result.data.error as string | undefined) ?? result.raw ?? `HTTP ${result.status}`;
    console.error(`HTTP ${result.status} ${path}`, error);
    process.exit(1);
  }
  return result.data;
}

(async () => {
  const intentJson = {
    type: "polymarket_cancel_order",
    order_id: orderId
  };

  const quote = await postOrExit("/api/can_do", proposeKey, { agent_id: agentId, intent_json: intentJson });
  console.log("QUOTE", quote);

  if (!quote.allowed) process.exit(0);
  if (quote.requires_step_up) {
    console.error("Step-up required before execute");
    process.exit(1);
  }

  const exec = await postOrExit("/api/execute", executeKey, {
    quote_id: quote.quote_id,
    idempotency_key: quote.idempotency_key
  });
  console.log("EXEC", exec);
})();
