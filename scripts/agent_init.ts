#!/usr/bin/env tsx
import "dotenv/config";

const baseUrl = (process.env.BLOOM_BASE_URL ?? `http://localhost:${process.env.PORT ?? "3000"}`).replace(/\/+$/, "");
const proposeKey = process.env.BLOOM_PROPOSE_KEY ?? "";
const readKey = process.env.BLOOM_READ_KEY ?? "";
const agentId = process.env.BLOOM_AGENT_ID ?? "agent_ej";

if (!proposeKey) {
  console.error("BLOOM_PROPOSE_KEY is required to create agents");
  process.exit(1);
}

type JsonValue = Record<string, unknown>;

type HttpResult = {
  ok: boolean;
  status: number;
  data: JsonValue;
  raw: string;
};

async function fetchJson(path: string, key: string, options?: RequestInit): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      ...(options?.headers ?? {})
    }
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

async function checkAgentExists(): Promise<boolean | null> {
  if (!readKey) return null;
  const result = await fetchJson(`/api/state?agent_id=${encodeURIComponent(agentId)}`, readKey, { method: "GET" });
  if (result.ok) return true;
  if (result.status === 404) return false;
  const error = (result.data.error as string | undefined) ?? result.raw;
  throw new Error(`Failed to check agent state: ${error || `HTTP ${result.status}`}`);
}

async function createAgent(): Promise<"created" | "exists"> {
  const result = await fetchJson("/api/agents", proposeKey, {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId })
  });

  if (result.ok) return "created";

  const message = result.raw || JSON.stringify(result.data);
  if (message.includes("UNIQUE constraint failed") && message.includes("agents.agent_id")) {
    return "exists";
  }

  const error = (result.data.error as string | undefined) ?? message;
  throw new Error(`Failed to create agent: ${error || `HTTP ${result.status}`}`);
}

async function main() {
  const exists = await checkAgentExists();
  if (exists === true) {
    console.log(`agent_id=${agentId} (already exists)`);
    return;
  }

  const status = await createAgent();
  if (status === "created") {
    console.log(`agent_id=${agentId} (created)`);
  } else {
    console.log(`agent_id=${agentId} (already exists)`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
