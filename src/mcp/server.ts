import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const baseUrl = process.env.BLOOM_BASE_URL?.replace(/\/+$/, "") ?? "";
const readKey = process.env.BLOOM_READ_KEY ?? "";
const proposeKey = process.env.BLOOM_PROPOSE_KEY ?? "";

function requireEnv(value: string, name: string) {
  if (!value) {
    throw new Error(`${name}_required`);
  }
  return value;
}

async function fetchJson<T>(input: {
  path: string;
  method?: "GET" | "POST";
  key: string;
  body?: Record<string, unknown>;
}): Promise<T> {
  const res = await fetch(`${baseUrl}${input.path}`, {
    method: input.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-api-key": input.key
    },
    body: input.body ? JSON.stringify(input.body) : undefined
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T) : ({} as T);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`) as Error & { response?: T };
    err.response = data;
    throw err;
  }
  return data;
}

function normalizeScopes(scopes: unknown): string[] {
  if (Array.isArray(scopes)) return scopes.map((s) => String(s));
  return [];
}

function validateReadScopes(scopes: string[]) {
  if (!scopes.includes("read")) throw new Error("READ_KEY_missing_read_scope");
  if (scopes.includes("propose") || scopes.includes("execute") || scopes.includes("owner") || scopes.includes("*")) {
    throw new Error("READ_KEY_scope_too_permissive");
  }
}

function validateProposeScopes(scopes: string[]) {
  if (!scopes.includes("propose")) throw new Error("PROPOSE_KEY_missing_propose_scope");
  if (scopes.includes("execute") || scopes.includes("owner") || scopes.includes("*")) {
    throw new Error("PROPOSE_KEY_scope_too_permissive");
  }
}

async function verifyKeys() {
  requireEnv(baseUrl, "BLOOM_BASE_URL");
  requireEnv(readKey, "BLOOM_READ_KEY");
  requireEnv(proposeKey, "BLOOM_PROPOSE_KEY");

  const readWhoami = await fetchJson<{ scopes: unknown }>({ path: "/api/whoami", key: readKey });
  const proposeWhoami = await fetchJson<{ scopes: unknown }>({ path: "/api/whoami", key: proposeKey });
  const readScopes = normalizeScopes(readWhoami.scopes);
  const proposeScopes = normalizeScopes(proposeWhoami.scopes);
  validateReadScopes(readScopes);
  validateProposeScopes(proposeScopes);
}

async function bloomGetState(agentId: string) {
  return fetchJson<Record<string, unknown>>({
    path: `/api/state?agent_id=${encodeURIComponent(agentId)}`,
    key: readKey,
    method: "GET"
  });
}

async function bloomListReceipts(agentId: string, since?: number, limit?: number) {
  const qs = new URLSearchParams({ agent_id: agentId });
  if (since !== undefined) qs.set("since", String(since));
  const data = await fetchJson<{ receipts?: unknown[] }>({
    path: `/api/receipts?${qs.toString()}`,
    key: readKey,
    method: "GET"
  });
  if (limit !== undefined && Array.isArray(data.receipts)) {
    return { receipts: data.receipts.slice(0, limit) };
  }
  return data;
}

async function bloomCanDo(agentId: string, intentJson: Record<string, unknown>, options?: { idempotency_key?: string }) {
  return fetchJson<Record<string, unknown>>({
    path: "/api/can_do",
    key: proposeKey,
    method: "POST",
    body: {
      agent_id: agentId,
      intent_json: intentJson,
      ...(options?.idempotency_key ? { idempotency_key: options.idempotency_key } : {})
    }
  });
}

async function main() {
  await verifyKeys();

  // Log to stderr so we don't interfere with MCP stdio protocol
  console.error(`Bloom MCP ready | ${baseUrl}`);

  const server = new Server(
    { name: "bloom-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "bloom_get_state",
        description: "Fetch the latest state and observation for an agent.",
        inputSchema: {
          type: "object",
          properties: { agent_id: { type: "string" } },
          required: ["agent_id"],
          additionalProperties: false
        }
      },
      {
        name: "bloom_list_receipts",
        description: "Fetch receipts for an agent.",
        inputSchema: {
          type: "object",
          properties: {
            agent_id: { type: "string" },
            since: { type: "number" },
            limit: { type: "number" }
          },
          required: ["agent_id"],
          additionalProperties: false
        }
      },
      {
        name: "bloom_can_do",
        description: "Request a quote to see if an intent is allowed.",
        inputSchema: {
          type: "object",
          properties: {
            agent_id: { type: "string" },
            intent_json: { type: "object" },
            options: {
              type: "object",
              properties: { idempotency_key: { type: "string" } },
              additionalProperties: false
            }
          },
          required: ["agent_id", "intent_json"],
          additionalProperties: false
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    if (name === "bloom_get_state") {
      const agentId = String(args.agent_id ?? "");
      const result = await bloomGetState(agentId);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "bloom_list_receipts") {
      const agentId = String(args.agent_id ?? "");
      const since = args.since !== undefined ? Number(args.since) : undefined;
      const limit = args.limit !== undefined ? Number(args.limit) : undefined;
      const result = await bloomListReceipts(agentId, since, limit);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "bloom_can_do") {
      const agentId = String(args.agent_id ?? "");
      const intentJson = (args.intent_json ?? {}) as Record<string, unknown>;
      const options = (args.options ?? {}) as { idempotency_key?: string };
      const result = await bloomCanDo(agentId, intentJson, options);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
