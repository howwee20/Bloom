import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const baseUrl = process.env.BLOOM_BASE_URL?.replace(/\/+$/, "") ?? "";
const readKey = process.env.BLOOM_READ_KEY ?? "";
const proposeKey = process.env.BLOOM_PROPOSE_KEY ?? "";
const executeKey = process.env.BLOOM_EXECUTE_KEY ?? "";
const adminKey = process.env.BLOOM_ADMIN_KEY ?? "";

type McpProfile = "claude" | "chatgpt";

type ToolDefinition = Tool & {
  annotations?: {
    readOnlyHint?: boolean;
  };
};

const CHATGPT_ALLOWED_TOOLS = new Set([
  "bloom_ui_state",
  "bloom_ui_activity",
  "bloom_polymarket_dryrun_place_order",
  "bloom_polymarket_dryrun_cancel_order",
  "bloom_polymarket_bot_status",
  "bloom_polymarket_dryrun_bot_status"
]);

export function resolveMcpProfile(value?: string): McpProfile {
  const normalized = (value ?? "claude").trim().toLowerCase();
  if (normalized === "claude" || normalized === "chatgpt") return normalized;
  throw new Error(`BLOOM_MCP_PROFILE_invalid:${value}`);
}

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

function validateExecuteScopes(scopes: string[]) {
  if (!scopes.includes("execute")) throw new Error("EXECUTE_KEY_missing_execute_scope");
  if (scopes.includes("propose") || scopes.includes("owner") || scopes.includes("*")) {
    throw new Error("EXECUTE_KEY_scope_too_permissive");
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

  if (executeKey) {
    const executeWhoami = await fetchJson<{ scopes: unknown }>({ path: "/api/whoami", key: executeKey });
    const executeScopes = normalizeScopes(executeWhoami.scopes);
    validateExecuteScopes(executeScopes);
  }
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "bloom_ui_state",
    description: "Use this when you need the user-facing spendable, balance, and held totals for an agent.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Agent identifier, e.g. `agent_ej`."
        }
      },
      required: ["agent_id"],
      additionalProperties: false
    }
  },
  {
    name: "bloom_ui_activity",
    description: "Use this when you need the UI activity feed entries for an agent.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Agent identifier, e.g. `agent_ej`."
        },
        limit: {
          type: "number",
          description: "Maximum number of activity items to return.",
          minimum: 1
        }
      },
      required: ["agent_id"],
      additionalProperties: false
    }
  },
  {
    name: "bloom_get_state",
    description: "Use this when you need the raw kernel state and observation for an agent (debugging).",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Agent identifier, e.g. `agent_ej`."
        }
      },
      required: ["agent_id"],
      additionalProperties: false
    }
  },
  {
    name: "bloom_list_receipts",
    description: "Use this when you need receipt ledger entries for an agent.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Agent identifier, e.g. `agent_ej`."
        },
        since: {
          type: "number",
          description: "Unix timestamp (seconds). Only include receipts at or after this time."
        },
        limit: {
          type: "number",
          description: "Maximum number of receipts to return.",
          minimum: 1
        }
      },
      required: ["agent_id"],
      additionalProperties: false
    }
  },
  {
    name: "bloom_can_do",
    description: "Use this when you want a quote to see if an intent is allowed, without executing it.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Agent identifier, e.g. `agent_ej`."
        },
        intent_json: {
          type: "object",
          description: "Intent payload with `type` and intent-specific fields.",
          additionalProperties: true
        },
        options: {
          type: "object",
          properties: {
            idempotency_key: {
              type: "string",
              description: "Optional idempotency key for safe retries."
            }
          },
          additionalProperties: false
        }
      },
      required: ["agent_id", "intent_json"],
      additionalProperties: false
    }
  },
  {
    name: "bloom_auto_execute",
    description: "Use this when you want to auto-execute an allowlisted USDC transfer.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Agent identifier, e.g. `agent_ej`."
        },
        intent_json: {
          type: "object",
          description: "USDC transfer intent payload.",
          properties: {
            type: {
              type: "string",
              enum: ["usdc_transfer"],
              description: "Optional; defaults to `usdc_transfer`."
            },
            to_address: {
              type: "string",
              description: "Recipient address (0x...)."
            },
            amount_cents: {
              type: "number",
              description: "Amount to transfer in USDC cents.",
              minimum: 1
            }
          },
          required: ["to_address", "amount_cents"],
          additionalProperties: true
        },
        options: {
          type: "object",
          properties: {
            idempotency_key: {
              type: "string",
              description: "Optional idempotency key for safe retries."
            }
          },
          additionalProperties: false
        }
      },
      required: ["agent_id", "intent_json"],
      additionalProperties: false
    }
  },
  {
    name: "bloom_polymarket_dryrun_place_order",
    description: "Use this when you want to place a Polymarket dry-run BUY order (no real trading).",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Agent identifier, e.g. `agent_ej`."
        },
        market_slug: {
          type: "string",
          description: "Polymarket market slug (Gamma)."
        },
        token_id: {
          type: "string",
          description: "Polymarket token id (YES/NO token)."
        },
        price: {
          type: "number",
          description: "Limit price between 0 and 1.",
          minimum: 0,
          maximum: 1
        },
        size: {
          type: "number",
          description: "Order size in contracts.",
          minimum: 1
        },
        client_order_id: {
          type: "string",
          description: "Optional client order id for idempotency."
        }
      },
      required: ["agent_id", "market_slug", "token_id", "price", "size"],
      additionalProperties: false
    }
  },
  {
    name: "bloom_polymarket_place_order",
    description: "Use this when you want to place a real Polymarket BUY order (requires execute scope).",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Agent identifier, e.g. `agent_ej`."
        },
        market_slug: {
          type: "string",
          description: "Polymarket market slug (Gamma)."
        },
        token_id: {
          type: "string",
          description: "Polymarket token id (YES/NO token)."
        },
        price: {
          type: "number",
          description: "Limit price between 0 and 1.",
          minimum: 0,
          maximum: 1
        },
        size: {
          type: "number",
          description: "Order size in contracts.",
          minimum: 1
        },
        client_order_id: {
          type: "string",
          description: "Optional client order id for idempotency."
        }
      },
      required: ["agent_id", "market_slug", "token_id", "price", "size"],
      additionalProperties: false
    }
  },
  {
    name: "bloom_polymarket_dryrun_cancel_order",
    description: "Use this when you want to cancel a Polymarket dry-run order.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Agent identifier, e.g. `agent_ej`."
        },
        order_id: {
          type: "string",
          description: "Order id to cancel."
        }
      },
      required: ["agent_id", "order_id"],
      additionalProperties: false
    }
  },
  {
    name: "bloom_polymarket_cancel_order",
    description: "Use this when you want to cancel a real Polymarket order (requires execute scope).",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Agent identifier, e.g. `agent_ej`."
        },
        order_id: {
          type: "string",
          description: "Order id to cancel."
        }
      },
      required: ["agent_id", "order_id"],
      additionalProperties: false
    }
  },
  {
    name: "bloom_polymarket_dryrun_bot_start",
    description: "Use this when you want to start the observe-only Polymarket dry-run bot.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Agent identifier, e.g. `agent_ej`."
        }
      },
      required: ["agent_id"],
      additionalProperties: false
    }
  },
  {
    name: "bloom_polymarket_bot_start",
    description: "Use this when you want to start the observe-only Polymarket bot (Gamma polling).",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Optional agent id override; defaults to the configured bot agent."
        }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "bloom_polymarket_reconcile_now",
    description: "Use this when you need to run a Polymarket reconciliation cycle (admin only).",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "bloom_polymarket_dryrun_bot_stop",
    description: "Use this when you want to stop the observe-only Polymarket dry-run bot.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "bloom_polymarket_bot_stop",
    description: "Use this when you want to stop the observe-only Polymarket bot.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "bloom_polymarket_dryrun_bot_status",
    description: "Use this when you want to check status for the Polymarket dry-run bot.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "bloom_polymarket_bot_status",
    description: "Use this when you want to check status for the Polymarket bot.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "bloom_polymarket_bot_kill",
    description: "Emergency kill switch. Stops the Polymarket bot immediately, optionally cancels open orders.",
    inputSchema: {
      type: "object",
      properties: {
        cancel_orders: {
          type: "boolean",
          description: "If true, also cancel all open orders for the agent."
        }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "bloom_step_up_approve",
    description: "Use this when you need to approve or deny a step-up challenge using the admin key.",
    inputSchema: {
      type: "object",
      properties: {
        quote_id: {
          type: "string",
          description: "Quote id for the step-up challenge."
        },
        approve: {
          type: "boolean",
          description: "true to approve, false to deny. Defaults to true."
        }
      },
      required: ["quote_id"],
      additionalProperties: false
    }
  }
];

export function buildToolDefinitions(profile: McpProfile): ToolDefinition[] {
  if (profile === "chatgpt") {
    return TOOL_DEFINITIONS.filter((tool) => CHATGPT_ALLOWED_TOOLS.has(tool.name));
  }
  return TOOL_DEFINITIONS;
}

function isToolAllowed(profile: McpProfile, name: string) {
  if (profile !== "chatgpt") return true;
  return CHATGPT_ALLOWED_TOOLS.has(name);
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

async function bloomExecute(quoteId: string, idempotencyKey: string) {
  if (!executeKey) {
    throw new Error("BLOOM_EXECUTE_KEY_required");
  }
  return fetchJson<Record<string, unknown>>({
    path: "/api/execute",
    key: executeKey,
    method: "POST",
    body: { quote_id: quoteId, idempotency_key: idempotencyKey }
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

async function bloomPolymarketPlaceOrder(input: {
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
  const quote = await bloomCanDo(input.agentId, intent);
  const allowed = Boolean((quote as { allowed?: boolean }).allowed);
  if (!allowed) return { quote, execution: null };
  const exec = await bloomExecute(String((quote as { quote_id?: string }).quote_id), String((quote as { idempotency_key?: string }).idempotency_key));
  return { quote, execution: exec };
}

async function bloomPolymarketCancelOrder(input: { agentId: string; orderId: string }) {
  const intent: Record<string, unknown> = {
    type: "polymarket_cancel_order",
    order_id: input.orderId
  };
  const quote = await bloomCanDo(input.agentId, intent);
  const allowed = Boolean((quote as { allowed?: boolean }).allowed);
  if (!allowed) return { quote, execution: null };
  const exec = await bloomExecute(String((quote as { quote_id?: string }).quote_id), String((quote as { idempotency_key?: string }).idempotency_key));
  return { quote, execution: exec };
}

async function bloomPolymarketReconcileNow() {
  requireEnv(adminKey, "BLOOM_ADMIN_KEY");
  return fetchJsonAdmin<Record<string, unknown>>({
    path: "/api/polymarket/reconcile",
    method: "POST",
    body: {}
  });
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

async function bloomPolymarketBotStart(agentId?: string) {
  requireEnv(adminKey, "BLOOM_ADMIN_KEY");
  return fetchJsonAdmin<Record<string, unknown>>({
    path: "/api/bots/polymarket/start",
    method: "POST",
    body: agentId ? { agent_id: agentId } : {}
  });
}

async function bloomPolymarketBotStop() {
  requireEnv(adminKey, "BLOOM_ADMIN_KEY");
  return fetchJsonAdmin<Record<string, unknown>>({
    path: "/api/bots/polymarket/stop",
    method: "POST",
    body: {}
  });
}

async function bloomPolymarketBotStatus() {
  return fetchJson<Record<string, unknown>>({
    path: "/api/bots/polymarket/status",
    key: readKey,
    method: "GET"
  });
}

async function bloomPolymarketBotKill(cancelOrders?: boolean) {
  requireEnv(adminKey, "BLOOM_ADMIN_KEY");
  return fetchJsonAdmin<Record<string, unknown>>({
    path: "/api/bots/polymarket/kill",
    method: "POST",
    body: cancelOrders ? { cancel_orders: true } : {}
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
  const mcpProfile = resolveMcpProfile(process.env.BLOOM_MCP_PROFILE);

  // Log to stderr so we don't interfere with MCP stdio protocol
  console.error(`Bloom MCP ready | ${baseUrl} | profile=${mcpProfile}`);

  const server = new Server(
    { name: "bloom-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolDefinitions(mcpProfile)
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (!isToolAllowed(mcpProfile, name)) {
      throw new Error(`Tool not available in ${mcpProfile} profile: ${name}`);
    }
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

    if (name === "bloom_polymarket_place_order") {
      const agentId = String(args.agent_id ?? "");
      const marketSlug = String(args.market_slug ?? "");
      const tokenId = String(args.token_id ?? "");
      const price = Number(args.price);
      const size = Number(args.size);
      const clientOrderId = args.client_order_id ? String(args.client_order_id) : undefined;
      const result = await bloomPolymarketPlaceOrder({ agentId, marketSlug, tokenId, price, size, clientOrderId });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "bloom_polymarket_dryrun_cancel_order") {
      const agentId = String(args.agent_id ?? "");
      const orderId = String(args.order_id ?? "");
      const result = await bloomPolymarketDryrunCancelOrder({ agentId, orderId });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "bloom_polymarket_cancel_order") {
      const agentId = String(args.agent_id ?? "");
      const orderId = String(args.order_id ?? "");
      const result = await bloomPolymarketCancelOrder({ agentId, orderId });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "bloom_polymarket_dryrun_bot_start") {
      const agentId = String(args.agent_id ?? "");
      const result = await bloomPolymarketDryrunBotStart(agentId);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "bloom_polymarket_bot_start") {
      const agentId = args.agent_id ? String(args.agent_id) : undefined;
      const result = await bloomPolymarketBotStart(agentId);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "bloom_polymarket_dryrun_bot_stop") {
      const result = await bloomPolymarketDryrunBotStop();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "bloom_polymarket_bot_stop") {
      const result = await bloomPolymarketBotStop();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "bloom_polymarket_dryrun_bot_status") {
      const result = await bloomPolymarketDryrunBotStatus();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "bloom_polymarket_bot_status") {
      const result = await bloomPolymarketBotStatus();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "bloom_polymarket_bot_kill") {
      const cancelOrders = args.cancel_orders === true;
      const result = await bloomPolymarketBotKill(cancelOrders);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "bloom_polymarket_reconcile_now") {
      const result = await bloomPolymarketReconcileNow();
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

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const isDirectRun =
  process.env.NODE_ENV !== "test" && entryPath && entryPath === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
