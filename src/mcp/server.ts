import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const baseUrl = process.env.BLOOM_BASE_URL?.replace(/\/+$/, "") ?? "";
const readKey = process.env.BLOOM_READ_KEY ?? "";
const proposeKey = process.env.BLOOM_PROPOSE_KEY ?? "";
const adminKey = process.env.BLOOM_ADMIN_KEY ?? "";

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

async function fetchJsonAdmin<T>(input: { path: string; method?: "GET" | "POST"; body?: Record<string, unknown> }): Promise<T> {
  const res = await fetch(`${baseUrl}${input.path}`, {
    method: input.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-admin-key": adminKey
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

function normalizeAmountCents(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return value;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return value;
}

function normalizeAutoExecuteIntent(intentJson: Record<string, unknown>) {
  const toAddress = String(intentJson.to_address ?? "").trim().toLowerCase();
  return {
    type: "usdc_transfer",
    to_address: toAddress,
    amount_cents: normalizeAmountCents(intentJson.amount_cents)
  } as Record<string, unknown>;
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

async function bloomUiState(agentId: string) {
  return fetchJson<Record<string, unknown>>({
    path: `/api/ui/state?agent_id=${encodeURIComponent(agentId)}`,
    key: readKey,
    method: "GET"
  });
}

async function bloomUiActivity(agentId: string, limit?: number) {
  const qs = new URLSearchParams({ agent_id: agentId });
  if (limit !== undefined) qs.set("limit", String(limit));
  return fetchJson<unknown>({
    path: `/api/ui/activity?${qs.toString()}`,
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

async function bloomAutoExecute(agentId: string, intentJson: Record<string, unknown>, options?: { idempotency_key?: string }) {
  return fetchJson<Record<string, unknown>>({
    path: "/api/auto_execute",
    key: proposeKey,
    method: "POST",
    body: {
      agent_id: agentId,
      intent_json: intentJson,
      ...(options?.idempotency_key ? { idempotency_key: options.idempotency_key } : {})
    }
  });
}

async function bloomPolymarketDryrunPlaceOrder(input: {
  agentId: string;
  marketSlug: string;
  tokenId: string;
  price: number;
  size: number;
  clientOrderId?: string;
}) {
  const intent: Record<string, unknown> = {
    type: "polymarket_place_order",
    market_slug: input.marketSlug,
    token_id: input.tokenId,
    side: "BUY",
    price: input.price,
    size: input.size
  };
  if (input.clientOrderId) {
    intent.client_order_id = input.clientOrderId;
  }
  return bloomAutoExecute(input.agentId, intent);
}

async function bloomPolymarketDryrunCancelOrder(input: { agentId: string; orderId: string }) {
  const intent: Record<string, unknown> = {
    type: "polymarket_cancel_order",
    order_id: input.orderId
  };
  return bloomAutoExecute(input.agentId, intent);
}

async function bloomPolymarketDryrunBotStart(agentId: string) {
  requireEnv(adminKey, "BLOOM_ADMIN_KEY");
  return fetchJsonAdmin<Record<string, unknown>>({
    path: "/api/bots/polymarket_dryrun/start",
    method: "POST",
    body: { agent_id: agentId }
  });
}

async function bloomPolymarketDryrunBotStop() {
  requireEnv(adminKey, "BLOOM_ADMIN_KEY");
  return fetchJsonAdmin<Record<string, unknown>>({
    path: "/api/bots/polymarket_dryrun/stop",
    method: "POST",
    body: {}
  });
}

async function bloomPolymarketDryrunBotStatus() {
  return fetchJson<Record<string, unknown>>({
    path: "/api/bots/polymarket_dryrun/status",
    key: readKey,
    method: "GET"
  });
}

async function bloomStepUpApprove(quoteId: string, approve: boolean) {
  requireEnv(adminKey, "BLOOM_ADMIN_KEY");
  return fetchJsonAdmin<Record<string, unknown>>({
    path: "/api/step_up/approve",
    method: "POST",
    body: { quote_id: quoteId, approve }
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
        name: "bloom_ui_state",
        description: "Fetch the user-facing spendable, balance, and held totals for an agent.",
        inputSchema: {
          type: "object",
          properties: { agent_id: { type: "string" } },
          required: ["agent_id"],
          additionalProperties: false
        }
      },
      {
        name: "bloom_ui_activity",
        description: "Fetch user-facing activity rollups for an agent.",
        inputSchema: {
          type: "object",
          properties: {
            agent_id: { type: "string" },
            limit: { type: "number" }
          },
          required: ["agent_id"],
          additionalProperties: false
        }
      },
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
      },
      {
        name: "bloom_auto_execute",
        description: "Auto-execute a USDC transfer if it is allowlisted and within auto-approve limits.",
        inputSchema: {
          type: "object",
          properties: {
            agent_id: { type: "string" },
            intent_json: {
              type: "object",
              properties: {
                to_address: { type: "string" },
                amount_cents: { type: "number" }
              },
              required: ["to_address", "amount_cents"],
              additionalProperties: true
            },
            options: {
              type: "object",
              properties: { idempotency_key: { type: "string" } },
              additionalProperties: false
            }
          },
          required: ["agent_id", "intent_json"],
          additionalProperties: false
        }
      },
      {
        name: "bloom_polymarket_dryrun_place_order",
        description: "Place a Polymarket dry-run BUY order (no real trading).",
        inputSchema: {
          type: "object",
          properties: {
            agent_id: { type: "string" },
            market_slug: { type: "string" },
            token_id: { type: "string" },
            price: { type: "number" },
            size: { type: "number" },
            client_order_id: { type: "string" }
          },
          required: ["agent_id", "market_slug", "token_id", "price", "size"],
          additionalProperties: false
        }
      },
      {
        name: "bloom_polymarket_dryrun_cancel_order",
        description: "Cancel a Polymarket dry-run order.",
        inputSchema: {
          type: "object",
          properties: {
            agent_id: { type: "string" },
            order_id: { type: "string" }
          },
          required: ["agent_id", "order_id"],
          additionalProperties: false
        }
      },
      {
        name: "bloom_polymarket_dryrun_bot_start",
        description: "Start the observe-only Polymarket dry-run bot.",
        inputSchema: {
          type: "object",
          properties: { agent_id: { type: "string" } },
          required: ["agent_id"],
          additionalProperties: false
        }
      },
      {
        name: "bloom_polymarket_dryrun_bot_stop",
        description: "Stop the observe-only Polymarket dry-run bot.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false
        }
      },
      {
        name: "bloom_polymarket_dryrun_bot_status",
        description: "Get status for the Polymarket dry-run bot.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false
        }
      },
      {
        name: "bloom_step_up_approve",
        description: "Approve or deny a step-up challenge using the admin key.",
        inputSchema: {
          type: "object",
          properties: {
            quote_id: { type: "string" },
            approve: { type: "boolean" }
          },
          required: ["quote_id"],
          additionalProperties: false
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    if (name === "bloom_ui_state") {
      const agentId = String(args.agent_id ?? "");
      const result = await bloomUiState(agentId);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "bloom_ui_activity") {
      const agentId = String(args.agent_id ?? "");
      const limit = args.limit !== undefined ? Number(args.limit) : undefined;
      const result = await bloomUiActivity(agentId, limit);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

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

    if (name === "bloom_auto_execute") {
      const agentId = String(args.agent_id ?? "");
      const intentJson = (args.intent_json ?? {}) as Record<string, unknown>;
      const options = (args.options ?? {}) as { idempotency_key?: string };
      const normalizedIntent = normalizeAutoExecuteIntent(intentJson);
      const result = await bloomAutoExecute(agentId, normalizedIntent, options);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "bloom_polymarket_dryrun_place_order") {
      const agentId = String(args.agent_id ?? "");
      const marketSlug = String(args.market_slug ?? "");
      const tokenId = String(args.token_id ?? "");
      const price = Number(args.price);
      const size = Number(args.size);
      const clientOrderId = args.client_order_id ? String(args.client_order_id) : undefined;
      const result = await bloomPolymarketDryrunPlaceOrder({ agentId, marketSlug, tokenId, price, size, clientOrderId });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "bloom_polymarket_dryrun_cancel_order") {
      const agentId = String(args.agent_id ?? "");
      const orderId = String(args.order_id ?? "");
      const result = await bloomPolymarketDryrunCancelOrder({ agentId, orderId });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "bloom_polymarket_dryrun_bot_start") {
      const agentId = String(args.agent_id ?? "");
      const result = await bloomPolymarketDryrunBotStart(agentId);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "bloom_polymarket_dryrun_bot_stop") {
      const result = await bloomPolymarketDryrunBotStop();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "bloom_polymarket_dryrun_bot_status") {
      const result = await bloomPolymarketDryrunBotStatus();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "bloom_step_up_approve") {
      const quoteId = String(args.quote_id ?? "");
      const approve = args.approve === undefined ? true : Boolean(args.approve);
      const result = await bloomStepUpApprove(quoteId, approve);
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
