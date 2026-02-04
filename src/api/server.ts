import "dotenv/config";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../db/database.js";
import { getConfig } from "../config.js";
import { Kernel } from "../kernel/kernel.js";
import { SimpleEconomyWorld } from "../env/simple_economy.js";
import { BaseUsdcWorld } from "../env/base_usdc.js";
import { buildUiActivity, formatMoney, shortenAddress } from "../presentation/index.js";
import {
  agentSpendSnapshot,
  agentTokens,
  agents,
  apiKeys,
  budgets,
  cardHolds,
  events,
  policies,
  quotes,
  receipts,
  stepUpChallenges,
  users
} from "../db/schema.js";
import { consoleSessions } from "../db/console_schema.js";
import { and, desc, eq } from "drizzle-orm";
import type { DbClient } from "../db/database.js";
import Database from "better-sqlite3";
import type { IEnvironment } from "../env/IEnvironment.js";
import { newId, nowSeconds } from "../kernel/utils.js";
import { appendEvent } from "../kernel/events.js";
import { createReceipt } from "../kernel/receipts.js";
import { refreshAgentSpendSnapshot } from "../kernel/spend_snapshot.js";
import { CARD_SIGNATURE_HEADER, CARD_TIMESTAMP_HEADER, verifyCardSignature } from "./card_webhook.js";
import {
  LITHIC_WEBHOOK_ID_HEADER,
  LITHIC_WEBHOOK_TIMESTAMP_HEADER,
  LITHIC_WEBHOOK_SIGNATURE_HEADER,
  verifyLithicWebhookSignature,
  mapLithicToCanonical,
  type LithicASARequest,
  type LithicASAResponse
} from "./lithic_webhook.js";

type AuthUser = {
  userId: string;
  keyId: string;
  scopes: string[];
};

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
    consoleSession?: { sessionId: string; userId: string; agentId: string };
  }
}

function ensureDbPath(dbPath: string) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function hashApiKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

function generateApiKey() {
  return `bloom_sk_${randomBytes(24).toString("hex")}`;
}

function parseScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function hasScope(scopes: string[] | undefined, required: "read" | "propose" | "execute" | "owner") {
  if (!scopes || scopes.length === 0) return false;
  if (scopes.includes("*") || scopes.includes("owner")) return true;
  if (required === "owner") return scopes.includes("owner");
  if (required === "execute") return scopes.includes("execute");
  if (required === "propose") return scopes.includes("propose") || scopes.includes("execute");
  if (required === "read") return scopes.includes("read") || scopes.includes("propose") || scopes.includes("execute");
  return false;
}

function requireScope(
  request: FastifyRequest,
  reply: FastifyReply,
  required: "read" | "propose" | "execute" | "owner"
) {
  const authUser = request.authUser;
  if (!authUser) {
    reply.status(401).send({ error: "api_key_required" });
    return false;
  }
  if (!hasScope(authUser.scopes, required)) {
    reply.status(403).send({ error: "insufficient_scope" });
    return false;
  }
  return true;
}

function ensureConsoleAgentMatch(request: FastifyRequest, reply: FastifyReply, agentId: string) {
  const session = request.consoleSession;
  if (!session) return true;
  if (session.agentId !== agentId) {
    reply.status(403).send({ error: "console_session_agent_mismatch" });
    return false;
  }
  return true;
}

function selectDefaultAgent(db: DbClient) {
  return db
    .select()
    .from(agents)
    .orderBy(desc(agents.updatedAt), desc(agents.createdAt))
    .limit(1)
    .get() as typeof agents.$inferSelect | undefined;
}

function createConsoleSessionRow(input: { consoleDb: DbClient; userId: string; agentId: string; apiKey: string }) {
  const now = nowSeconds();
  const sessionId = newId("console");
  input.consoleDb.insert(consoleSessions).values({
    sessionId,
    userId: input.userId,
    agentId: input.agentId,
    apiKey: input.apiKey,
    status: "active",
    createdAt: now,
    lastUsedAt: now
  }).run();
  return sessionId;
}

function parseWindowSeconds(value: string | undefined, fallbackSeconds: number) {
  if (!value) return fallbackSeconds;
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+)([smhd])$/i);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const mult =
      unit === "s"
        ? 1
        : unit === "m"
          ? 60
          : unit === "h"
            ? 3600
            : unit === "d"
              ? 86400
              : 1;
    return amount * mult;
  }
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : fallbackSeconds;
}

type ConsoleChatMessage = { role: "user" | "assistant"; content: string };

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

type AnthropicResponse = {
  id: string;
  type: string;
  role: "assistant";
  content: AnthropicContentBlock[];
  stop_reason: string;
};

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[] | unknown[];
};

function isLoopback(ip: string | undefined) {
  if (!ip) return false;
  return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("::ffff:127.");
}

function allowConsoleBootstrap(
  config: ReturnType<typeof getConfig>,
  request: FastifyRequest,
  reply: FastifyReply,
  token?: string
) {
  if (config.CONSOLE_BOOTSTRAP_TOKEN) {
    if (token !== config.CONSOLE_BOOTSTRAP_TOKEN) {
      reply.status(403).send({ error: "bootstrap_token_required" });
      return false;
    }
    return true;
  }
  if (!isLoopback(request.ip)) {
    reply.status(403).send({ error: "bootstrap_locked" });
    return false;
  }
  return true;
}

function resolveConsoleAsset(assetName: string) {
  const candidates = [path.resolve("src/console", assetName), path.resolve("dist/console", assetName)];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function callAnthropic(options: {
  apiKey: string;
  model: string;
  system: string;
  messages: AnthropicMessage[];
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  maxTokens?: number;
}) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": options.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: options.model,
      system: options.system,
      max_tokens: options.maxTokens ?? 800,
      messages: options.messages,
      tools: options.tools,
      temperature: 0.2
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(raw || `Anthropic error ${response.status}`);
  }
  return JSON.parse(raw) as AnthropicResponse;
}

function buildConsoleSystemPrompt(agentId: string) {
  return [
    "You are Bloom, a money assistant.",
    "You can read state and propose intents, but you must never execute actions.",
    "Always call tools to answer balance questions. Never guess.",
    "When a user asks to move money, propose a quote via kernel_can_do and ask for approval.",
    "Keep responses short, direct, and focused on what is available and what happens next.",
    `Agent id: ${agentId}.`,
    "Do not mention crypto, keys, or blockchains. Use plain banking language."
  ].join(" ");
}

function summarizeIntent(intent: Record<string, unknown>) {
  const type = String(intent.type ?? "");
  if (type === "usdc_transfer") {
    const amount = Number(intent.amount_cents ?? 0);
    const toAddress = String(intent.to_address ?? "");
    const amountLabel = Number.isFinite(amount) && amount > 0 ? formatMoney(amount) : "an amount";
    const toLabel = toAddress ? shortenAddress(toAddress) : "a recipient";
    return `Send ${amountLabel} to ${toLabel}`;
  }
  if (type === "send_credits") {
    const amount = Number(intent.amount_cents ?? 0);
    const toAgent = String(intent.to_agent_id ?? "");
    const amountLabel = Number.isFinite(amount) && amount > 0 ? formatMoney(amount) : "credits";
    const toLabel = toAgent ? toAgent : "agent";
    return `Send ${amountLabel} to ${toLabel}`;
  }
  return `Intent: ${type || "unknown"}`;
}

type CardAuthResponse = {
  approved: boolean;
  shadow: boolean;
  would_approve?: boolean;
  would_decline_reason?: string | null;
  auth_status?: string;
  idempotent?: boolean;
};

function requireAdminKey(config: ReturnType<typeof getConfig>, request: FastifyRequest, reply: FastifyReply) {
  if (!config.ADMIN_API_KEY) {
    reply.status(403).send({ error: "admin_key_not_configured" });
    return false;
  }
  const headerKey = String(request.headers["x-admin-key"] ?? "");
  if (headerKey !== config.ADMIN_API_KEY) {
    reply.status(403).send({ error: "forbidden" });
    return false;
  }
  return true;
}

function ensureAgentOwnership(db: DbClient, agentId: string, userId: string) {
  const agent = db.select().from(agents).where(eq(agents.agentId, agentId)).get();
  if (!agent) {
    return { ok: false as const, statusCode: 404, error: "agent_not_found" };
  }
  if (agent.userId !== userId) {
    return { ok: false as const, statusCode: 403, error: "forbidden" };
  }
  return { ok: true as const };
}

function resolveGitSha() {
  const envSha =
    process.env.GIT_SHA ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GITHUB_SHA ??
    process.env.SOURCE_VERSION ??
    null;
  if (envSha) return envSha;
  try {
    const headPath = path.resolve(".git", "HEAD");
    if (!fs.existsSync(headPath)) return null;
    const head = fs.readFileSync(headPath, "utf8").trim();
    if (!head) return null;
    if (!head.startsWith("ref:")) return head;
    const ref = head.replace(/^ref:\s*/, "");
    const refPath = path.resolve(".git", ref);
    if (fs.existsSync(refPath)) {
      return fs.readFileSync(refPath, "utf8").trim();
    }
    const packedPath = path.resolve(".git", "packed-refs");
    if (fs.existsSync(packedPath)) {
      const packed = fs.readFileSync(packedPath, "utf8");
      const match = packed
        .split("\n")
        .find((line) => line && !line.startsWith("#") && line.endsWith(` ${ref}`));
      if (match) return match.split(" ")[0] ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

function findMigrationsDir() {
  const candidates = [
    path.resolve("src/db/migrations"),
    path.resolve("dist/db/migrations"),
    path.resolve("db/migrations")
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  }
  return null;
}

function migrationsApplied(sqlite: Database) {
  try {
    const table = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get() as { name?: string } | undefined;
    if (!table?.name) return false;
    const appliedRows = sqlite.prepare("SELECT name FROM schema_migrations").all() as { name: string }[];
    const applied = new Set(appliedRows.map((row) => row.name));
    const migrationsDir = findMigrationsDir();
    if (!migrationsDir) return applied.size > 0;
    const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
    return files.every((file) => applied.has(file));
  } catch {
    return false;
  }
}

export function buildServer(options: {
  config?: ReturnType<typeof getConfig>;
  db?: DbClient;
  sqlite?: Database;
  consoleDb?: DbClient;
  consoleSqlite?: Database;
  env?: IEnvironment;
} = {}) {
  const config = options.config ?? getConfig();
  const isMemoryPath = (value: string) => value === ":memory:" || value === "file::memory:";
  if (!isMemoryPath(config.DB_PATH)) {
    ensureDbPath(config.DB_PATH);
  }
  const kernelBundle =
    options.db && options.sqlite
      ? { sqlite: options.sqlite, db: options.db }
      : createDatabase(config.DB_PATH);

  const consoleDbPath = config.CONSOLE_DB_PATH ?? config.DB_PATH;
  if (!isMemoryPath(consoleDbPath)) {
    ensureDbPath(consoleDbPath);
  }
  const consoleBundle =
    options.consoleDb && options.consoleSqlite
      ? { sqlite: options.consoleSqlite, db: options.consoleDb }
      : consoleDbPath === config.DB_PATH
        ? kernelBundle
        : createDatabase(consoleDbPath);

  const env =
    options.env ??
    (config.ENV_TYPE === "base_usdc"
      ? new BaseUsdcWorld(kernelBundle.db, kernelBundle.sqlite, config)
      : new SimpleEconomyWorld(kernelBundle.db, kernelBundle.sqlite, config));
  const kernel = new Kernel(kernelBundle.db, kernelBundle.sqlite, env, config);

  const db = kernelBundle.db;
  const sqlite = kernelBundle.sqlite;
  const consoleDb = consoleBundle.db;
  const consoleSqlite = consoleBundle.sqlite;

  const app = Fastify({ logger: true });

  const rateBuckets = new Map<string, { count: number; resetAt: number }>();
  const RATE_LIMIT_WINDOW_SECONDS = 60;
  const RATE_LIMIT_MAX_PER_KEY = 60;
  const RATE_LIMIT_MAX_PER_IP = 120;

  app.get("/healthz", { config: { auth: "public" } }, async (_request, reply) => {
    let dbConnected = false;
    try {
      sqlite.prepare("SELECT 1").get();
      dbConnected = true;
    } catch {
      dbConnected = false;
    }

    return reply.send({
      api_version: config.API_VERSION,
      db_connected: dbConnected,
      migrations_applied: migrationsApplied(sqlite),
      card_mode: config.CARD_MODE,
      env_type: config.ENV_TYPE,
      git_sha: resolveGitSha()
    });
  });

  function consumeRate(key: string, max: number, now: number) {
    const existing = rateBuckets.get(key);
    if (!existing || now >= existing.resetAt) {
      rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_SECONDS });
      return true;
    }
    if (existing.count >= max) return false;
    existing.count += 1;
    return true;
  }

  app.addHook("preHandler", async (request, reply) => {
    const configAuth = request.routeOptions.config as
      | { auth?: "admin" | "public" | "user" | "console" }
      | undefined;
    const authMode = configAuth?.auth ?? "user";
    if (authMode === "admin" || authMode === "public") return;

    const now = nowSeconds();
    const ipKey = `ip:${request.ip ?? "unknown"}`;
    if (!consumeRate(ipKey, RATE_LIMIT_MAX_PER_IP, now)) {
      reply.status(429).send({ error: "rate_limited" });
      return;
    }

    if (authMode === "console") {
      const sessionId = String(request.headers["x-console-session"] ?? "");
      if (sessionId) {
        const session = consoleDb
          .select()
          .from(consoleSessions)
          .where(eq(consoleSessions.sessionId, sessionId))
          .get() as typeof consoleSessions.$inferSelect | undefined;
        if (!session || session.status !== "active") {
          reply.status(401).send({ error: "invalid_console_session" });
          return;
        }

        const keyHash = hashApiKey(session.apiKey);
        if (!consumeRate(`key:${keyHash}`, RATE_LIMIT_MAX_PER_KEY, now)) {
          reply.status(429).send({ error: "rate_limited" });
          return;
        }

        const keyRow = db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).get();
        if (!keyRow || keyRow.status !== "active") {
          reply.status(401).send({ error: "invalid_api_key" });
          return;
        }

        consoleDb
          .update(consoleSessions)
          .set({ lastUsedAt: now })
          .where(eq(consoleSessions.sessionId, sessionId))
          .run();

        request.consoleSession = {
          sessionId: session.sessionId,
          userId: session.userId,
          agentId: session.agentId
        };
        request.authUser = {
          userId: keyRow.userId,
          keyId: keyRow.keyId,
          scopes: parseScopes(keyRow.scopesJson)
        };
        return;
      }
    }

    const apiKey = String(request.headers["x-api-key"] ?? "");
    if (!apiKey) {
      reply.status(401).send({ error: "api_key_required" });
      return;
    }

    const keyHash = hashApiKey(apiKey);
    if (!consumeRate(`key:${keyHash}`, RATE_LIMIT_MAX_PER_KEY, now)) {
      reply.status(429).send({ error: "rate_limited" });
      return;
    }

    const keyRow = db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).get();
    if (!keyRow || keyRow.status !== "active") {
      reply.status(401).send({ error: "invalid_api_key" });
      return;
    }
    request.authUser = {
      userId: keyRow.userId,
      keyId: keyRow.keyId,
      scopes: parseScopes(keyRow.scopesJson)
    };
  });

  app.get("/api/health", { config: { auth: "public" } }, async (_request, reply) => {
    return reply.send({ status: "ok", version: config.API_VERSION });
  });

  app.get("/api/whoami", async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) return reply.status(401).send({ error: "api_key_required" });
    return reply.send({ user_id: authUser.userId, key_id: authUser.keyId, scopes: authUser.scopes });
  });

  app.post("/api/agents", async (request, reply) => {
    const body = (request.body ?? {}) as { user_id?: string; agent_id?: string };
    if (!requireScope(request, reply, "propose")) return;
    const authUser = request.authUser as AuthUser;
    if (body.user_id && body.user_id !== authUser.userId) {
      return reply.status(403).send({ error: "forbidden" });
    }
    const result = await kernel.createAgent({ userId: authUser.userId, agentId: body.agent_id });
    return reply.send(result);
  });

  app.post("/api/can_do", async (request, reply) => {
    const body = request.body as {
      user_id: string;
      agent_id: string;
      intent_json: Record<string, unknown>;
      idempotency_key?: string;
    };
    if (!requireScope(request, reply, "propose")) return;
    const authUser = request.authUser as AuthUser;
    if (body.user_id && body.user_id !== authUser.userId) {
      return reply.status(403).send({ error: "forbidden" });
    }
    const ownership = ensureAgentOwnership(db, body.agent_id, authUser.userId);
    if (!ownership.ok) return reply.status(ownership.statusCode).send({ error: ownership.error });
    const result = await kernel.canDo({ ...body, user_id: authUser.userId });
    return reply.send(result);
  });

  app.post("/api/execute", async (request, reply) => {
    const body = request.body as {
      quote_id: string;
      idempotency_key: string;
      step_up_token?: string;
      override_freshness?: boolean;
    };
    if (!requireScope(request, reply, "execute")) return;
    const authUser = request.authUser as AuthUser;
    const quote = db.select().from(quotes).where(eq(quotes.quoteId, body.quote_id)).get();
    if (quote && quote.userId !== authUser.userId) {
      return reply.status(403).send({ error: "forbidden" });
    }
    const stepUpHeader = String(request.headers["x-step-up"] ?? "");
    const stepUpToken = body.step_up_token ?? (stepUpHeader.length > 0 ? stepUpHeader : undefined);
    const result = await kernel.execute({ ...body, step_up_token: stepUpToken });
    return reply.send(result);
  });

  app.post("/api/step_up/request", async (request, reply) => {
    const body = request.body as { agent_id?: string; quote_id?: string };
    if (!body.agent_id || !body.quote_id) return reply.status(400).send({ error: "agent_id_and_quote_id_required" });
    if (!requireScope(request, reply, "owner")) return;
    const authUser = request.authUser as AuthUser;
    const ownership = ensureAgentOwnership(db, body.agent_id, authUser.userId);
    if (!ownership.ok) return reply.status(ownership.statusCode).send({ error: ownership.error });
    const quote = db.select().from(quotes).where(eq(quotes.quoteId, body.quote_id)).get();
    if (!quote) return reply.status(404).send({ error: "quote_not_found" });
    if (quote.userId !== authUser.userId || quote.agentId !== body.agent_id) {
      return reply.status(403).send({ error: "forbidden" });
    }
    if (quote.requiresStepUp !== 1) {
      return reply.status(400).send({ error: "step_up_not_required" });
    }
    const challenge = await kernel.requestStepUpChallenge({
      user_id: authUser.userId,
      agent_id: body.agent_id,
      quote_id: body.quote_id
    });
    if (challenge.code) {
      // eslint-disable-next-line no-console
      console.log(`[step-up] challenge_id=${challenge.challenge_id} code=${challenge.code}`);
    }
    const approvalUrl = `http://127.0.0.1:${config.APPROVAL_UI_PORT}/approve/${challenge.challenge_id}`;
    return reply.send({ challenge_id: challenge.challenge_id, approval_url: approvalUrl, expires_at: challenge.expires_at });
  });

  app.get("/api/state", async (request, reply) => {
    const query = request.query as { agent_id?: string };
    if (!query.agent_id) return reply.status(400).send({ error: "agent_id_required" });
    if (!requireScope(request, reply, "read")) return;
    const authUser = request.authUser as AuthUser;
    const ownership = ensureAgentOwnership(db, query.agent_id, authUser.userId);
    if (!ownership.ok) return reply.status(ownership.statusCode).send({ error: ownership.error });
    const state = await kernel.getState(query.agent_id);
    return reply.send(state);
  });

  app.get("/api/receipts", async (request, reply) => {
    const query = request.query as { agent_id?: string; since?: string };
    if (!query.agent_id) return reply.status(400).send({ error: "agent_id_required" });
    if (!requireScope(request, reply, "read")) return;
    const authUser = request.authUser as AuthUser;
    const ownership = ensureAgentOwnership(db, query.agent_id, authUser.userId);
    if (!ownership.ok) return reply.status(ownership.statusCode).send({ error: ownership.error });
    const since = query.since ? Number(query.since) : undefined;
    const rows = kernel.getReceipts(query.agent_id, since);
    return reply.send({ receipts: rows });
  });

  app.get("/api/agents/:agent_id/summary", async (request, reply) => {
    const params = request.params as { agent_id: string };
    const query = request.query as { window?: string };
    if (!requireScope(request, reply, "read")) return;
    const authUser = request.authUser as AuthUser;
    const ownership = ensureAgentOwnership(db, params.agent_id, authUser.userId);
    if (!ownership.ok) return reply.status(ownership.statusCode).send({ error: ownership.error });
    const windowSeconds = parseWindowSeconds(query.window, 7 * 24 * 3600);
    const summary = kernel.getAgentSummary(params.agent_id, windowSeconds);
    return reply.send(summary);
  });

  app.get("/api/agents/:agent_id/timeline", async (request, reply) => {
    const params = request.params as { agent_id: string };
    const query = request.query as { since?: string; limit?: string };
    if (!requireScope(request, reply, "read")) return;
    const authUser = request.authUser as AuthUser;
    const ownership = ensureAgentOwnership(db, params.agent_id, authUser.userId);
    if (!ownership.ok) return reply.status(ownership.statusCode).send({ error: ownership.error });
    const since = query.since ? Number(query.since) : undefined;
    const limit = query.limit ? Number(query.limit) : undefined;
    const timeline = kernel.getAgentTimeline(params.agent_id, since, limit);
    return reply.send({ timeline });
  });

  app.get("/api/agents/:agent_id/receipt/:receipt_id", async (request, reply) => {
    const params = request.params as { agent_id: string; receipt_id: string };
    if (!requireScope(request, reply, "read")) return;
    const authUser = request.authUser as AuthUser;
    const ownership = ensureAgentOwnership(db, params.agent_id, authUser.userId);
    if (!ownership.ok) return reply.status(ownership.statusCode).send({ error: ownership.error });
    const result = kernel.getReceiptWithFacts(params.agent_id, params.receipt_id);
    if (!result) return reply.status(404).send({ error: "receipt_not_found" });
    return reply.send(result);
  });

  // Bloom Console (reference client)
  app.get("/console", { config: { auth: "public" } }, async (_request, reply) => {
    const assetPath = resolveConsoleAsset("index.html");
    if (!assetPath) return reply.status(404).send("Console not found");
    const html = fs.readFileSync(assetPath, "utf8");
    return reply.type("text/html").send(html);
  });

  app.get("/console/app.js", { config: { auth: "public" } }, async (_request, reply) => {
    const assetPath = resolveConsoleAsset("app.js");
    if (!assetPath) return reply.status(404).send("Not found");
    const js = fs.readFileSync(assetPath, "utf8");
    return reply.type("text/javascript").send(js);
  });

  app.get("/console/styles.css", { config: { auth: "public" } }, async (_request, reply) => {
    const assetPath = resolveConsoleAsset("styles.css");
    if (!assetPath) return reply.status(404).send("Not found");
    const css = fs.readFileSync(assetPath, "utf8");
    return reply.type("text/css").send(css);
  });

  app.post("/console/bootstrap", { config: { auth: "public" } }, async (request, reply) => {
    const body = (request.body ?? {}) as { bootstrap_token?: string; confirm_text?: string };
    if (!allowConsoleBootstrap(config, request, reply, body.bootstrap_token)) return;
    if (body.confirm_text !== "CREATE") {
      return reply.status(400).send({ error: "confirm_required" });
    }

    const created = kernel.createAgent();
    const apiKey = generateApiKey();
    const keyHash = hashApiKey(apiKey);
    const keyId = newId("key");
    db.insert(apiKeys).values({
      keyId,
      userId: created.user_id,
      keyHash,
      scopesJson: ["*"],
      status: "active",
      createdAt: nowSeconds()
    }).run();

    const sessionId = createConsoleSessionRow({
      consoleDb,
      userId: created.user_id,
      agentId: created.agent_id,
      apiKey
    });
    return reply.send({ user_id: created.user_id, agent_id: created.agent_id, session_id: sessionId });
  });

  app.post("/console/login", { config: { auth: "public" } }, async (request, reply) => {
    const body = (request.body ?? {}) as { bootstrap_token?: string };
    if (!allowConsoleBootstrap(config, request, reply, body.bootstrap_token)) return;

    const agent = selectDefaultAgent(db);
    if (!agent) return reply.status(404).send({ error: "no_agents_found" });

    const apiKey = generateApiKey();
    const keyHash = hashApiKey(apiKey);
    const keyId = newId("key");
    db.insert(apiKeys).values({
      keyId,
      userId: agent.userId,
      keyHash,
      scopesJson: ["*"],
      status: "active",
      createdAt: nowSeconds()
    }).run();

    const sessionId = createConsoleSessionRow({
      consoleDb,
      userId: agent.userId,
      agentId: agent.agentId,
      apiKey
    });
    return reply.send({ user_id: agent.userId, agent_id: agent.agentId, session_id: sessionId });
  });

  app.post("/console/import", { config: { auth: "public" } }, async (request, reply) => {
    const body = (request.body ?? {}) as { api_key?: string; agent_id?: string; bootstrap_token?: string };
    if (!allowConsoleBootstrap(config, request, reply, body.bootstrap_token)) return;
    if (!body.api_key || !body.agent_id) {
      return reply.status(400).send({ error: "api_key_and_agent_id_required" });
    }

    const keyHash = hashApiKey(body.api_key);
    const keyRow = db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).get();
    if (!keyRow || keyRow.status !== "active") {
      return reply.status(401).send({ error: "invalid_api_key" });
    }

    const ownership = ensureAgentOwnership(db, body.agent_id, keyRow.userId);
    if (!ownership.ok) return reply.status(ownership.statusCode).send({ error: ownership.error });

    const sessionId = createConsoleSessionRow({
      consoleDb,
      userId: keyRow.userId,
      agentId: body.agent_id,
      apiKey: body.api_key
    });
    return reply.send({ user_id: keyRow.userId, agent_id: body.agent_id, session_id: sessionId });
  });

  app.get("/console/overview", { config: { auth: "console" } }, async (request, reply) => {
    const query = request.query as { agent_id?: string };
    if (!query.agent_id) return reply.status(400).send({ error: "agent_id_required" });
    if (!requireScope(request, reply, "read")) return;
    if (!ensureConsoleAgentMatch(request, reply, query.agent_id)) return;
    const authUser = request.authUser as AuthUser;
    const ownership = ensureAgentOwnership(db, query.agent_id, authUser.userId);
    if (!ownership.ok) return reply.status(ownership.statusCode).send({ error: ownership.error });
    const state = await kernel.getState(query.agent_id);
    const receiptRows = kernel.getReceipts(query.agent_id);
    const activity = buildUiActivity(receiptRows, { limit: 12 });
    return reply.send({ state, activity, updated_at: nowSeconds() });
  });

  app.post("/console/chat", { config: { auth: "console" } }, async (request, reply) => {
    const body = (request.body ?? {}) as { agent_id?: string; messages?: ConsoleChatMessage[] };
    if (!body.agent_id) return reply.status(400).send({ error: "agent_id_required" });
    if (!requireScope(request, reply, "propose")) return;
    if (!ensureConsoleAgentMatch(request, reply, body.agent_id)) return;
    const authUser = request.authUser as AuthUser;
    const ownership = ensureAgentOwnership(db, body.agent_id, authUser.userId);
    if (!ownership.ok) return reply.status(ownership.statusCode).send({ error: ownership.error });
    if (!config.ANTHROPIC_API_KEY) return reply.status(400).send({ error: "anthropic_api_key_missing" });

    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const messages = rawMessages
      .filter((msg) => msg && (msg.role === "user" || msg.role === "assistant"))
      .slice(-12);
    const system = buildConsoleSystemPrompt(body.agent_id);
    const tools = [
      {
        name: "kernel_state",
        description: "Get current spend power and wallet state for the agent.",
        input_schema: { type: "object", properties: {} }
      },
      {
        name: "kernel_receipts",
        description: "Get recent receipts for the agent.",
        input_schema: { type: "object", properties: { limit: { type: "number" } } }
      },
      {
        name: "kernel_can_do",
        description: "Propose an intent and receive a quote for approval.",
        input_schema: {
          type: "object",
          properties: {
            intent: { type: "object", description: "Intent JSON. Example: {\"type\":\"usdc_transfer\",\"amount_cents\":500,\"to_address\":\"0x...\"}" }
          },
          required: ["intent"]
        }
      }
    ];

    const pendingQuotes: Array<{
      quote_id: string;
      allowed: boolean;
      requires_step_up: boolean;
      reason: string;
      expires_at: number;
      idempotency_key: string;
      summary: string;
    }> = [];

    const toolHandlers = {
      kernel_state: async () => await kernel.getState(body.agent_id as string),
      kernel_receipts: async (input: Record<string, unknown>) => {
        const limit = Number(input.limit ?? 6);
        const rows = kernel.getReceipts(body.agent_id as string);
        return buildUiActivity(rows, { limit: Number.isFinite(limit) ? limit : 6 });
      },
      kernel_can_do: async (input: Record<string, unknown>) => {
        const intent = (input.intent ?? {}) as Record<string, unknown>;
        const idempotencyKey = newId("idem");
        const quote = await kernel.canDo({
          user_id: authUser.userId,
          agent_id: body.agent_id as string,
          intent_json: intent,
          idempotency_key: idempotencyKey
        });
        pendingQuotes.push({
          quote_id: quote.quote_id,
          allowed: quote.allowed,
          requires_step_up: quote.requires_step_up,
          reason: quote.reason,
          expires_at: quote.expires_at,
          idempotency_key: quote.idempotency_key,
          summary: summarizeIntent(intent)
        });
        return {
          quote_id: quote.quote_id,
          allowed: quote.allowed,
          requires_step_up: quote.requires_step_up,
          reason: quote.reason,
          expires_at: quote.expires_at
        };
      }
    };

    const anthropicMessages: AnthropicMessage[] = messages.map((msg) => ({
      role: msg.role,
      content: msg.content
    }));

    let assistantText = "";
    let nextMessages: AnthropicMessage[] = [...anthropicMessages];

    for (let step = 0; step < 2; step += 1) {
      const response = await callAnthropic({
        apiKey: config.ANTHROPIC_API_KEY,
        model: config.ANTHROPIC_MODEL,
        system,
        messages: nextMessages,
        tools
      });

      const toolUses = response.content.filter((block) => block.type === "tool_use");
      const textBlocks = response.content.filter((block) => block.type === "text");
      if (!toolUses.length) {
        assistantText = textBlocks.map((block) => block.text).join("");
        break;
      }

      nextMessages = [...nextMessages, { role: "assistant", content: response.content }];

      const toolResults = [];
      for (const toolUse of toolUses) {
        const handler = toolHandlers[toolUse.name as keyof typeof toolHandlers];
        if (!handler) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({ error: "unknown_tool" })
          });
          continue;
        }
        const result = await handler(toolUse.input ?? {});
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result)
        });
      }

      nextMessages = [
        ...nextMessages,
        {
          role: "user",
          content: toolResults
        }
      ];

      if (response.stop_reason !== "tool_use") {
        assistantText = textBlocks.map((block) => block.text).join("");
        break;
      }
    }

    if (!assistantText) assistantText = "I'm ready when you are.";
    return reply.send({ assistant: assistantText, pending_quotes: pendingQuotes });
  });

  app.post("/console/execute", { config: { auth: "console" } }, async (request, reply) => {
    const body = request.body as {
      quote_id?: string;
      idempotency_key?: string;
      step_up_token?: string;
      override_freshness?: boolean;
    };
    if (!body.quote_id || !body.idempotency_key) {
      return reply.status(400).send({ error: "quote_id_and_idempotency_key_required" });
    }
    if (!requireScope(request, reply, "execute")) return;
    const authUser = request.authUser as AuthUser;
    const quote = db.select().from(quotes).where(eq(quotes.quoteId, body.quote_id)).get();
    if (quote && quote.userId !== authUser.userId) {
      return reply.status(403).send({ error: "forbidden" });
    }
    if (quote && request.consoleSession && quote.agentId !== request.consoleSession.agentId) {
      return reply.status(403).send({ error: "console_session_agent_mismatch" });
    }
    const result = await kernel.execute({
      quote_id: body.quote_id,
      idempotency_key: body.idempotency_key,
      step_up_token: body.step_up_token,
      override_freshness: body.override_freshness
    });
    return reply.send(result);
  });

  app.post("/console/step_up/request", { config: { auth: "console" } }, async (request, reply) => {
    const body = request.body as { agent_id?: string; quote_id?: string };
    if (!body.agent_id || !body.quote_id) return reply.status(400).send({ error: "agent_id_and_quote_id_required" });
    if (!requireScope(request, reply, "owner")) return;
    if (!ensureConsoleAgentMatch(request, reply, body.agent_id)) return;
    const authUser = request.authUser as AuthUser;
    const ownership = ensureAgentOwnership(db, body.agent_id, authUser.userId);
    if (!ownership.ok) return reply.status(ownership.statusCode).send({ error: ownership.error });
    const challenge = await kernel.requestStepUpChallenge({
      user_id: authUser.userId,
      agent_id: body.agent_id,
      quote_id: body.quote_id
    });
    return reply.send(challenge);
  });

  app.post("/console/step_up/confirm", { config: { auth: "console" } }, async (request, reply) => {
    const body = request.body as { challenge_id?: string; code?: string; decision?: "approve" | "deny" };
    if (!body.challenge_id || !body.code || !body.decision) {
      return reply.status(400).send({ error: "challenge_id_code_decision_required" });
    }
    if (!requireScope(request, reply, "owner")) return;
    if (request.consoleSession) {
      const challenge = db
        .select()
        .from(stepUpChallenges)
        .where(eq(stepUpChallenges.id, body.challenge_id))
        .get();
      if (challenge && challenge.agentId !== request.consoleSession.agentId) {
        return reply.status(403).send({ error: "console_session_agent_mismatch" });
      }
    }
    const result = await kernel.confirmStepUpChallenge({
      challenge_id: body.challenge_id,
      code: body.code,
      decision: body.decision
    });
    if (result.ok === false) {
      const error = "reason" in result ? result.reason : "unknown_error";
      return reply.status(400).send({ error });
    }
    return reply.send(result.response);
  });

  app.post("/console/freeze", { config: { auth: "console" } }, async (request, reply) => {
    const body = request.body as { agent_id?: string; reason?: string };
    if (!body.agent_id) return reply.status(400).send({ error: "agent_id_required" });
    if (!requireScope(request, reply, "owner")) return;
    if (!ensureConsoleAgentMatch(request, reply, body.agent_id)) return;
    const authUser = request.authUser as AuthUser;
    const ownership = ensureAgentOwnership(db, body.agent_id, authUser.userId);
    if (!ownership.ok) return reply.status(ownership.statusCode).send({ error: ownership.error });
    const result = kernel.freezeAgent(body.agent_id, body.reason ?? "console_freeze");
    return reply.send(result);
  });

  app.get("/console/debug", { config: { auth: "public" } }, async (request, reply) => {
    if (!isLoopback(request.ip) || process.env.NODE_ENV === "production") {
      return reply.status(403).send({ error: "forbidden" });
    }
    const agent = selectDefaultAgent(db);
    if (!agent) {
      return reply.send({
        db_path: config.DB_PATH,
        console_db_path: config.CONSOLE_DB_PATH,
        agent_id: null,
        wallet_address: null,
        confirmed_balance_cents: null,
        available_cents: null,
        confirmed: null,
        available: null
      });
    }
    const state = await kernel.getState(agent.agentId);
    const spend = state?.spend_power ?? {};
    return reply.send({
      db_path: config.DB_PATH,
      console_db_path: config.CONSOLE_DB_PATH,
      agent_id: agent.agentId,
      wallet_address: state?.observation?.wallet_address ?? null,
      confirmed_balance_cents: spend.confirmed_balance_cents ?? null,
      available_cents: spend.effective_spend_power_cents ?? null,
      confirmed: spend.confirmed_balance_cents ?? null,
      available: spend.effective_spend_power_cents ?? null
    });
  });

  app.post("/api/card/auth", { config: { auth: "public" } }, async (request, reply) => {
    const body = request.body as {
      auth_id?: string;
      card_id?: string;
      agent_id?: string;
      merchant?: string;
      mcc?: string;
      amount_cents?: number;
      currency?: string;
      timestamp?: number;
      metadata?: Record<string, unknown>;
    };
    const authId = String(body.auth_id ?? "");
    const cardId = String(body.card_id ?? "");
    const agentId = String(body.agent_id ?? cardId);
    const amountCents = Number(body.amount_cents);
    if (!authId || !agentId || !Number.isFinite(amountCents) || amountCents <= 0) {
      return reply.status(400).send({ error: "invalid_request" });
    }

    const cardMode = config.CARD_MODE;
    const signature = String(request.headers[CARD_SIGNATURE_HEADER] ?? "");
    const timestamp = String(request.headers[CARD_TIMESTAMP_HEADER] ?? "");
    let authStatus = "signed";

    if (cardMode !== "dev") {
      if (!config.CARD_WEBHOOK_SHARED_SECRET) {
        return reply.send({ approved: false, shadow: cardMode === "shadow", auth_status: "unauthenticated" });
      }
      const verification = verifyCardSignature({
        secret: config.CARD_WEBHOOK_SHARED_SECRET,
        signature,
        timestamp,
        body,
        now: nowSeconds()
      });
      if (!verification.ok) {
        return reply.send({ approved: false, shadow: cardMode === "shadow", auth_status: "unauthenticated" });
      }
    } else {
      if (!config.CARD_WEBHOOK_SHARED_SECRET || !signature || !timestamp) {
        authStatus = "dev_unsigned";
      } else {
        const verification = verifyCardSignature({
          secret: config.CARD_WEBHOOK_SHARED_SECRET,
          signature,
          timestamp,
          body,
          now: nowSeconds()
        });
        authStatus = verification.ok ? "signed" : "dev_unsigned";
      }
    }

    const existingReceipt = db
      .select()
      .from(receipts)
      .where(eq(receipts.externalRef, authId))
      .orderBy(desc(receipts.createdAt))
      .get();
    if (existingReceipt?.eventId) {
      const event = db.select().from(events).where(eq(events.eventId, existingReceipt.eventId)).get();
      const payload = event ? parseJson<Record<string, unknown>>(event.payloadJson, {}) : {};
      const response = payload.response as CardAuthResponse | undefined;
      if (response) {
        return reply.send({ ...response, idempotent: true });
      }
    }

    const agent = db.select().from(agents).where(eq(agents.agentId, agentId)).get();
    if (!agent) {
      const approved = cardMode !== "enforce";
      const shadow = cardMode !== "enforce";
      return reply.send({
        approved,
        shadow,
        would_approve: false,
        would_decline_reason: "agent_not_found",
        auth_status: authStatus
      });
    }

    const existingHold = db.select().from(cardHolds).where(eq(cardHolds.authId, authId)).get();
    if (existingHold) {
      return reply.send({
        approved: cardMode === "enforce" ? existingHold.status !== "reversed" : true,
        shadow: cardMode !== "enforce",
        idempotent: true
      });
    }

    let snapshot =
      (db
        .select()
        .from(agentSpendSnapshot)
        .where(eq(agentSpendSnapshot.agentId, agentId))
        .get() as typeof agentSpendSnapshot.$inferSelect | undefined) ??
      refreshAgentSpendSnapshot({ db, sqlite, config, agentId });

    const policyRow = db
      .select()
      .from(policies)
      .where(and(eq(policies.agentId, agentId), eq(policies.userId, agent.userId)))
      .orderBy(desc(policies.createdAt))
      .get() as typeof policies.$inferSelect | undefined;
    const policy = policyRow
      ? {
          daily_limit: parseJson(policyRow.dailyLimitJson, {})
        }
      : { daily_limit: {} as { max_spend_cents?: number } };

    const budget = db.select().from(budgets).where(eq(budgets.agentId, agentId)).get();
    const dailyMax = policy.daily_limit.max_spend_cents ?? budget?.dailySpendCents ?? 0;
    const dailyRemaining = Math.max(0, dailyMax - (budget?.dailySpendUsedCents ?? 0));

    let wouldApprove = false;
    let wouldDeclineReason: string | null = null;
    if (!snapshot) {
      wouldDeclineReason = "snapshot_missing";
    } else if (amountCents > snapshot.policySpendableCents) {
      wouldDeclineReason = "policy_limit_exceeded";
    } else if (amountCents > snapshot.effectiveSpendPowerCents) {
      wouldDeclineReason = "insufficient_spend_power";
    } else {
      wouldApprove = true;
    }

    const now = nowSeconds();
    const approved = cardMode === "enforce" ? wouldApprove : true;
    const shadow = cardMode !== "enforce";
    const response: CardAuthResponse = {
      approved,
      shadow,
      would_approve: wouldApprove,
      would_decline_reason: wouldDeclineReason,
      auth_status: authStatus
    };

    const tx = sqlite.transaction(() => {
      if (approved || cardMode !== "enforce") {
        db.insert(cardHolds).values({
          authId,
          agentId,
          amountCents,
          status: approved ? "pending" : "reversed",
          createdAt: now,
          updatedAt: now
        }).run();

        if (snapshot && approved) {
          const updatedReservedHolds = snapshot.reservedHoldsCents + amountCents;
          const confirmedSpendableCents =
            snapshot.confirmedBalanceCents -
            snapshot.reservedOutgoingCents -
            updatedReservedHolds -
            config.USDC_BUFFER_CENTS;
          const effectiveSpendPowerCents = Math.min(snapshot.policySpendableCents, confirmedSpendableCents);
          db.update(agentSpendSnapshot)
            .set({
              reservedHoldsCents: updatedReservedHolds,
              effectiveSpendPowerCents,
              updatedAt: now
            })
            .where(eq(agentSpendSnapshot.agentId, agentId))
            .run();
        }
      }

      const event = appendEvent(db, sqlite, {
        agentId,
        userId: agent.userId,
        type: "card_auth_shadow",
        payload: {
          auth_id: authId,
          card_id: cardId,
          agent_id: agentId,
          merchant: body.merchant ?? null,
          mcc: body.mcc ?? null,
          amount_cents: amountCents,
          currency: body.currency ?? null,
          timestamp: body.timestamp ?? null,
          metadata: body.metadata ?? null,
          auth_status: authStatus,
          shadow_mode: shadow,
          would_approve: wouldApprove,
          would_decline_reason: wouldDeclineReason,
          spend_snapshot: snapshot ?? null,
          policy_caps: { daily_limit_cents: dailyMax, daily_remaining_cents: dailyRemaining },
          facts_snapshot: snapshot
            ? {
                policy_caps: { daily_limit_cents: dailyMax, daily_remaining_cents: dailyRemaining },
                reserves: {
                  reserved_outgoing_cents: snapshot.reservedOutgoingCents,
                  reserved_holds_cents: snapshot.reservedHoldsCents
                },
                buffer_cents: config.USDC_BUFFER_CENTS,
                confirmed_balance_cents: snapshot.confirmedBalanceCents
              }
            : null,
          response
        }
      });

      createReceipt(db, {
        agentId,
        userId: agent.userId,
        source: "policy",
        eventId: event.event_id,
        externalRef: authId,
        whatHappened: "Card auth observed in shadow mode.",
        whyChanged:
          cardMode === "enforce"
            ? approved
              ? "card_auth_approved"
              : "card_auth_declined"
            : wouldApprove
              ? "shadow_would_approve"
              : "shadow_would_decline",
        whatHappensNext: "Hold recorded; shadow decision logged."
      });
    });
    tx();

    return reply.send(response);
  });

  app.post("/api/card/settle", { config: { auth: "admin" } }, async (request, reply) => {
    if (!requireAdminKey(config, request, reply)) return;
    const body = request.body as {
      agent_id?: string;
      auth_id?: string;
      settled_amount_cents?: number;
      settled_at?: number;
      metadata?: Record<string, unknown>;
    };
    const agentId = String(body.agent_id ?? "");
    const authId = String(body.auth_id ?? "");
    const settledAmountCents = Number(body.settled_amount_cents);
    if (!agentId || !authId || !Number.isFinite(settledAmountCents) || settledAmountCents < 0) {
      return reply.status(400).send({ error: "invalid_request" });
    }

    const hold = db.select().from(cardHolds).where(eq(cardHolds.authId, authId)).get();
    if (!hold || hold.agentId !== agentId) {
      return reply.status(404).send({ error: "hold_not_found" });
    }
    if (hold.status === "settled") {
      return reply.send({ ok: true, idempotent: true });
    }
    if (hold.status !== "pending") {
      return reply.status(409).send({ error: "hold_not_pending" });
    }

    const agent = db.select().from(agents).where(eq(agents.agentId, agentId)).get();
    if (!agent) {
      return reply.status(404).send({ error: "agent_not_found" });
    }

    const snapshot = db
      .select()
      .from(agentSpendSnapshot)
      .where(eq(agentSpendSnapshot.agentId, agentId))
      .get() as typeof agentSpendSnapshot.$inferSelect | undefined;
    if (!snapshot) {
      return reply.status(409).send({ error: "snapshot_missing" });
    }

    const now = nowSeconds();
    const occurredAt = body.settled_at ?? now;
    const tx = sqlite.transaction(() => {
      db.update(cardHolds)
        .set({ status: "settled", updatedAt: now })
        .where(eq(cardHolds.authId, authId))
        .run();

      const nextReservedHolds = Math.max(0, snapshot.reservedHoldsCents - hold.amountCents);
      const confirmedSpendableCents =
        snapshot.confirmedBalanceCents -
        snapshot.reservedOutgoingCents -
        nextReservedHolds -
        config.USDC_BUFFER_CENTS;
      const nextEffectiveSpendPower = Math.min(snapshot.policySpendableCents, confirmedSpendableCents);

      db.update(agentSpendSnapshot)
        .set({
          reservedHoldsCents: nextReservedHolds,
          effectiveSpendPowerCents: nextEffectiveSpendPower,
          updatedAt: now
        })
        .where(eq(agentSpendSnapshot.agentId, agentId))
        .run();

      const factsSnapshot = {
        policy_caps: {
          policy_spendable_cents: snapshot.policySpendableCents
        },
        reserves: {
          reserved_outgoing_cents: snapshot.reservedOutgoingCents,
          reserved_holds_cents: nextReservedHolds
        },
        buffer_cents: config.USDC_BUFFER_CENTS,
        confirmed_balance_cents: snapshot.confirmedBalanceCents
      };

      const event = appendEvent(db, sqlite, {
        agentId,
        userId: agent.userId,
        type: "card_settled",
        payload: {
          auth_id: authId,
          agent_id: agentId,
          hold_amount_cents: hold.amountCents,
          settled_amount_cents: settledAmountCents,
          settled_at: occurredAt,
          metadata: body.metadata ?? null,
          facts_snapshot: factsSnapshot
        },
        occurredAt
      });

      createReceipt(db, {
        agentId,
        userId: agent.userId,
        source: "policy",
        eventId: event.event_id,
        externalRef: authId,
        whatHappened: "Card hold settled.",
        whyChanged: "card_settled",
        whatHappensNext: "Hold released from reserves.",
        occurredAt
      });
    });
    tx();

    return reply.send({ ok: true });
  });

  app.post("/api/card/release", { config: { auth: "admin" } }, async (request, reply) => {
    if (!requireAdminKey(config, request, reply)) return;
    const body = request.body as {
      agent_id?: string;
      auth_id?: string;
      reason?: "expired" | "reversed" | "voided";
      released_at?: number;
    };
    const agentId = String(body.agent_id ?? "");
    const authId = String(body.auth_id ?? "");
    const reason = body.reason;
    if (!agentId || !authId || !reason) {
      return reply.status(400).send({ error: "invalid_request" });
    }

    const hold = db.select().from(cardHolds).where(eq(cardHolds.authId, authId)).get();
    if (!hold || hold.agentId !== agentId) {
      return reply.status(404).send({ error: "hold_not_found" });
    }
    if (hold.status === "released") {
      return reply.send({ ok: true, idempotent: true });
    }
    if (hold.status !== "pending") {
      return reply.status(409).send({ error: "hold_not_pending" });
    }

    const agent = db.select().from(agents).where(eq(agents.agentId, agentId)).get();
    if (!agent) {
      return reply.status(404).send({ error: "agent_not_found" });
    }

    const snapshot = db
      .select()
      .from(agentSpendSnapshot)
      .where(eq(agentSpendSnapshot.agentId, agentId))
      .get() as typeof agentSpendSnapshot.$inferSelect | undefined;
    if (!snapshot) {
      return reply.status(409).send({ error: "snapshot_missing" });
    }

    const now = nowSeconds();
    const occurredAt = body.released_at ?? now;
    const tx = sqlite.transaction(() => {
      db.update(cardHolds)
        .set({ status: "released", updatedAt: now })
        .where(eq(cardHolds.authId, authId))
        .run();

      const nextReservedHolds = Math.max(0, snapshot.reservedHoldsCents - hold.amountCents);
      const confirmedSpendableCents =
        snapshot.confirmedBalanceCents -
        snapshot.reservedOutgoingCents -
        nextReservedHolds -
        config.USDC_BUFFER_CENTS;
      const nextEffectiveSpendPower = Math.min(snapshot.policySpendableCents, confirmedSpendableCents);

      db.update(agentSpendSnapshot)
        .set({
          reservedHoldsCents: nextReservedHolds,
          effectiveSpendPowerCents: nextEffectiveSpendPower,
          updatedAt: now
        })
        .where(eq(agentSpendSnapshot.agentId, agentId))
        .run();

      const factsSnapshot = {
        policy_caps: {
          policy_spendable_cents: snapshot.policySpendableCents
        },
        reserves: {
          reserved_outgoing_cents: snapshot.reservedOutgoingCents,
          reserved_holds_cents: nextReservedHolds
        },
        buffer_cents: config.USDC_BUFFER_CENTS,
        confirmed_balance_cents: snapshot.confirmedBalanceCents
      };

      const event = appendEvent(db, sqlite, {
        agentId,
        userId: agent.userId,
        type: "card_released",
        payload: {
          auth_id: authId,
          agent_id: agentId,
          hold_amount_cents: hold.amountCents,
          released_at: occurredAt,
          reason,
          facts_snapshot: factsSnapshot
        },
        occurredAt
      });

      createReceipt(db, {
        agentId,
        userId: agent.userId,
        source: "policy",
        eventId: event.event_id,
        externalRef: authId,
        whatHappened: "Card hold released.",
        whyChanged: "card_released",
        whatHappensNext: "Hold released from reserves.",
        occurredAt
      });
    });
    tx();

    return reply.send({ ok: true });
  });

  // Lithic ASA (Auth Stream Access) responder endpoint
  // This endpoint receives real-time authorization requests from Lithic
  // Must respond within 3 seconds (Lithic times out at 6 seconds)
  app.post("/webhooks/lithic/asa", { config: { auth: "public" } }, async (request, reply) => {
    const startTime = Date.now();
    const cardMode = config.CARD_MODE;

    // Get raw body for signature verification
    const rawBody = JSON.stringify(request.body);
    const webhookId = String(request.headers[LITHIC_WEBHOOK_ID_HEADER] ?? "");
    const webhookTimestamp = String(request.headers[LITHIC_WEBHOOK_TIMESTAMP_HEADER] ?? "");
    const webhookSignature = String(request.headers[LITHIC_WEBHOOK_SIGNATURE_HEADER] ?? "");

    let authStatus = "signed";

    // Signature verification (fail-closed in shadow/enforce modes)
    if (cardMode !== "dev") {
      if (!config.LITHIC_ASA_SECRET) {
        // eslint-disable-next-line no-console
        console.error("[lithic-asa] LITHIC_ASA_SECRET not configured, failing closed");
        const response: LithicASAResponse = { result: "DECLINED" };
        return reply.send(response);
      }

      const verification = verifyLithicWebhookSignature({
        secret: config.LITHIC_ASA_SECRET,
        webhookId,
        webhookTimestamp,
        webhookSignature,
        rawBody,
        now: nowSeconds()
      });

      if (!verification.ok) {
        // eslint-disable-next-line no-console
        console.error(`[lithic-asa] Signature verification failed: ${verification.reason}`);
        const response: LithicASAResponse = { result: "DECLINED" };
        return reply.send(response);
      }
    } else {
      // Dev mode: log but don't fail on missing/invalid signature
      if (!config.LITHIC_ASA_SECRET || !webhookSignature) {
        authStatus = "dev_unsigned";
      } else {
        const verification = verifyLithicWebhookSignature({
          secret: config.LITHIC_ASA_SECRET,
          webhookId,
          webhookTimestamp,
          webhookSignature,
          rawBody,
          now: nowSeconds()
        });
        authStatus = verification.ok ? "signed" : "dev_unsigned";
      }
    }

    // Parse and map Lithic payload to canonical format
    const lithicPayload = request.body as LithicASARequest;
    const canonical = mapLithicToCanonical(lithicPayload);

    const { auth_id: authId, card_id: cardId, agent_id: agentId, amount_cents: amountCents } = canonical;

    if (!authId || !agentId || !Number.isFinite(amountCents) || amountCents <= 0) {
      // eslint-disable-next-line no-console
      console.error("[lithic-asa] Invalid request payload", { authId, agentId, amountCents });
      const response: LithicASAResponse = { result: "DECLINED" };
      return reply.send(response);
    }

    // Check for existing hold (idempotency)
    const existingReceipt = db
      .select()
      .from(receipts)
      .where(eq(receipts.externalRef, authId))
      .orderBy(desc(receipts.createdAt))
      .get();
    if (existingReceipt?.eventId) {
      const event = db.select().from(events).where(eq(events.eventId, existingReceipt.eventId)).get();
      const payload = event ? parseJson<Record<string, unknown>>(event.payloadJson, {}) : {};
      const cachedResponse = payload.lithic_response as LithicASAResponse | undefined;
      if (cachedResponse) {
        return reply.send(cachedResponse);
      }
    }

    const existingHold = db.select().from(cardHolds).where(eq(cardHolds.authId, authId)).get();
    if (existingHold) {
      const response: LithicASAResponse = {
        result: cardMode === "enforce" && existingHold.status === "reversed" ? "DECLINED" : "APPROVED",
        token: lithicPayload.token
      };
      return reply.send(response);
    }

    // Load agent (create if doesn't exist in dev/shadow mode for testing)
    let agent = db.select().from(agents).where(eq(agents.agentId, agentId)).get();
    if (!agent) {
      // In shadow/dev mode, approve but log the issue
      // eslint-disable-next-line no-console
      console.warn(`[lithic-asa] Agent not found: ${agentId}`);

      const wouldDeclineReason = "agent_not_found";
      const approved = cardMode !== "enforce";
      const response: LithicASAResponse = {
        result: approved ? "APPROVED" : "DECLINED",
        token: lithicPayload.token
      };

      // Log even without agent for debugging
      // eslint-disable-next-line no-console
      console.log(`[lithic-asa] ${approved ? "APPROVED" : "DECLINED"} auth_id=${authId} would_decline_reason=${wouldDeclineReason} latency=${Date.now() - startTime}ms`);

      return reply.send(response);
    }

    // Load or create spend snapshot
    let snapshot =
      (db
        .select()
        .from(agentSpendSnapshot)
        .where(eq(agentSpendSnapshot.agentId, agentId))
        .get() as typeof agentSpendSnapshot.$inferSelect | undefined) ??
      refreshAgentSpendSnapshot({ db, sqlite, config, agentId });

    // Load policy
    const policyRow = db
      .select()
      .from(policies)
      .where(and(eq(policies.agentId, agentId), eq(policies.userId, agent.userId)))
      .orderBy(desc(policies.createdAt))
      .get() as typeof policies.$inferSelect | undefined;
    const policy = policyRow
      ? { daily_limit: parseJson(policyRow.dailyLimitJson, {}) }
      : { daily_limit: {} as { max_spend_cents?: number } };

    const budget = db.select().from(budgets).where(eq(budgets.agentId, agentId)).get();
    const dailyMax = policy.daily_limit.max_spend_cents ?? budget?.dailySpendCents ?? 0;
    const dailyRemaining = Math.max(0, dailyMax - (budget?.dailySpendUsedCents ?? 0));

    // Determine if we would approve
    let wouldApprove = false;
    let wouldDeclineReason: string | null = null;
    if (!snapshot) {
      wouldDeclineReason = "snapshot_missing";
    } else if (amountCents > snapshot.policySpendableCents) {
      wouldDeclineReason = "policy_limit_exceeded";
    } else if (amountCents > snapshot.effectiveSpendPowerCents) {
      wouldDeclineReason = "insufficient_spend_power";
    } else {
      wouldApprove = true;
    }

    const now = nowSeconds();
    // In shadow mode: always approve but log would_decline
    // In enforce mode: actually decline if policy says no
    const approved = cardMode === "enforce" ? wouldApprove : true;
    const shadow = cardMode !== "enforce";

    const lithicResponse: LithicASAResponse = {
      result: approved ? "APPROVED" : "DECLINED",
      token: lithicPayload.token
    };

    const tx = sqlite.transaction(() => {
      if (approved || cardMode !== "enforce") {
        db.insert(cardHolds).values({
          authId,
          agentId,
          amountCents,
          status: approved ? "pending" : "reversed",
          createdAt: now,
          updatedAt: now
        }).run();

        if (snapshot && approved) {
          const updatedReservedHolds = snapshot.reservedHoldsCents + amountCents;
          const confirmedSpendableCents =
            snapshot.confirmedBalanceCents -
            snapshot.reservedOutgoingCents -
            updatedReservedHolds -
            config.USDC_BUFFER_CENTS;
          const effectiveSpendPowerCents = Math.min(snapshot.policySpendableCents, confirmedSpendableCents);
          db.update(agentSpendSnapshot)
            .set({
              reservedHoldsCents: updatedReservedHolds,
              effectiveSpendPowerCents,
              updatedAt: now
            })
            .where(eq(agentSpendSnapshot.agentId, agentId))
            .run();
        }
      }

      // Create event - note: we store original Lithic payload in metadata, not in kernel events
      const event = appendEvent(db, sqlite, {
        agentId,
        userId: agent.userId,
        type: "card_auth_shadow",
        payload: {
          // Canonical fields only - no Lithic payload shapes in kernel events
          auth_id: authId,
          card_id: cardId,
          agent_id: agentId,
          merchant: canonical.merchant,
          mcc: canonical.mcc,
          amount_cents: amountCents,
          currency: canonical.currency,
          timestamp: canonical.timestamp,
          metadata: canonical.metadata, // Lithic-specific data isolated here
          auth_status: authStatus,
          shadow_mode: shadow,
          would_approve: wouldApprove,
          would_decline_reason: wouldDeclineReason,
          spend_snapshot: snapshot ?? null,
          policy_caps: { daily_limit_cents: dailyMax, daily_remaining_cents: dailyRemaining },
          facts_snapshot: snapshot
            ? {
                policy_caps: { daily_limit_cents: dailyMax, daily_remaining_cents: dailyRemaining },
                reserves: {
                  reserved_outgoing_cents: snapshot.reservedOutgoingCents,
                  reserved_holds_cents: snapshot.reservedHoldsCents
                },
                buffer_cents: config.USDC_BUFFER_CENTS,
                confirmed_balance_cents: snapshot.confirmedBalanceCents
              }
            : null,
          lithic_response: lithicResponse
        }
      });

      createReceipt(db, {
        agentId,
        userId: agent.userId,
        source: "policy",
        eventId: event.event_id,
        externalRef: authId,
        whatHappened: `Card auth ${shadow ? "observed in shadow mode" : approved ? "approved" : "declined"}.`,
        whyChanged:
          cardMode === "enforce"
            ? approved
              ? "card_auth_approved"
              : "card_auth_declined"
            : wouldApprove
              ? "shadow_would_approve"
              : "shadow_would_decline",
        whatHappensNext: shadow
          ? `Hold recorded; shadow decision logged.${wouldDeclineReason ? ` Would decline: ${wouldDeclineReason}` : ""}`
          : approved
            ? "Hold created; funds reserved."
            : `Transaction declined: ${wouldDeclineReason}`
      });
    });
    tx();

    const latency = Date.now() - startTime;
    // eslint-disable-next-line no-console
    console.log(`[lithic-asa] ${lithicResponse.result} auth_id=${authId} amount=${amountCents} would_approve=${wouldApprove} latency=${latency}ms`);

    if (latency > 2000) {
      // eslint-disable-next-line no-console
      console.warn(`[lithic-asa] SLOW RESPONSE: ${latency}ms (target <3s, timeout at 6s)`);
    }

    return reply.send(lithicResponse);
  });

  app.post("/api/freeze", async (request, reply) => {
    const body = request.body as { agent_id: string; reason?: string };
    if (!body.agent_id) return reply.status(400).send({ error: "agent_id_required" });
    const authUser = request.authUser;
    if (!authUser) return reply.status(401).send({ error: "api_key_required" });
    const ownership = ensureAgentOwnership(db, body.agent_id, authUser.userId);
    if (!ownership.ok) return reply.status(ownership.statusCode).send({ error: ownership.error });
    const result = kernel.freezeAgent(body.agent_id, body.reason ?? "manual_freeze");
    return reply.send(result);
  });

  app.post("/api/revoke_token", async (request, reply) => {
    const body = request.body as { token_id: string };
    if (!body.token_id) return reply.status(400).send({ error: "token_id_required" });
    const authUser = request.authUser;
    if (!authUser) return reply.status(401).send({ error: "api_key_required" });
    const token = db.select().from(agentTokens).where(eq(agentTokens.tokenId, body.token_id)).get();
    if (token && token.userId !== authUser.userId) {
      return reply.status(403).send({ error: "forbidden" });
    }
    const result = kernel.revokeToken(body.token_id);
    return reply.send(result);
  });

  app.get("/api/truth_console", { config: { auth: "admin" } }, async (request, reply) => {
    const query = request.query as { agent_id?: string };
    if (!query.agent_id) return reply.status(400).send({ error: "agent_id_required" });
    if (config.ADMIN_API_KEY) {
      const headerKey = String(request.headers["x-admin-key"] ?? "");
      if (headerKey !== config.ADMIN_API_KEY) return reply.status(403).send({ error: "forbidden" });
    }

    const state = await kernel.getState(query.agent_id);
    const recentReceipts = kernel.getReceipts(query.agent_id).slice(-20);
    const budget = db.select().from(budgets).where(eq(budgets.agentId, query.agent_id)).get();
    return reply.send({
      state,
      env_freshness: state.env_freshness,
      budget,
      recent_receipts: recentReceipts
    });
  });

  app.post("/api/admin/keys", { config: { auth: "admin" } }, async (request, reply) => {
    if (!requireAdminKey(config, request, reply)) return;
    const body = (request.body ?? {}) as { user_id?: string; scopes?: string[] };
    const userId = body.user_id ?? newId("user");
    const scopes = Array.isArray(body.scopes) && body.scopes.length > 0 ? body.scopes : ["*"];
    const existingUser = db.select().from(users).where(eq(users.userId, userId)).get();
    if (!existingUser) {
      db.insert(users).values({ userId, createdAt: nowSeconds() }).run();
    }
    const apiKey = generateApiKey();
    const keyHash = hashApiKey(apiKey);
    const keyId = newId("key");
    db.insert(apiKeys).values({
      keyId,
      userId,
      keyHash,
      scopesJson: scopes,
      status: "active",
      createdAt: nowSeconds()
    }).run();
    return reply.send({ key_id: keyId, user_id: userId, api_key: apiKey, scopes });
  });

  app.post("/api/admin/keys/revoke", { config: { auth: "admin" } }, async (request, reply) => {
    if (!requireAdminKey(config, request, reply)) return;
    const body = (request.body ?? {}) as { key_id?: string; api_key?: string };
    if (!body.key_id && !body.api_key) return reply.status(400).send({ error: "key_id_or_api_key_required" });
    const now = nowSeconds();
    if (body.api_key) {
      const keyHash = hashApiKey(body.api_key);
      const row = db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).get();
      if (!row) return reply.status(404).send({ error: "key_not_found" });
      db.update(apiKeys).set({ status: "revoked", revokedAt: now }).where(eq(apiKeys.keyId, row.keyId)).run();
      return reply.send({ ok: true });
    }
    const row = db.select().from(apiKeys).where(eq(apiKeys.keyId, body.key_id ?? "")).get();
    if (!row) return reply.status(404).send({ error: "key_not_found" });
    db.update(apiKeys).set({ status: "revoked", revokedAt: now }).where(eq(apiKeys.keyId, row.keyId)).run();
    return reply.send({ ok: true });
  });

  return { app, kernel, env, db, sqlite, config, consoleDb, consoleSqlite };
}

export function buildApprovalServer(input: {
  config: ReturnType<typeof getConfig>;
  kernel: Kernel;
  db: DbClient;
}) {
  const { config, kernel, db } = input;
  const app = Fastify({ logger: true });

  app.get("/approve/:challengeId", async (request, reply) => {
    const params = request.params as { challengeId: string };
    const challenge = db
      .select()
      .from(stepUpChallenges)
      .where(eq(stepUpChallenges.id, params.challengeId))
      .get() as typeof stepUpChallenges.$inferSelect | undefined;
    const now = nowSeconds();
    if (!challenge) {
      return reply
        .status(404)
        .type("text/html")
        .send("<!doctype html><html><body><h2>Challenge not found.</h2></body></html>");
    }

    const expired = challenge.expiresAt <= now;
    const pending = challenge.status === "pending" && !expired;
    const statusText = expired
      ? "expired"
      : challenge.status === "pending"
        ? "pending"
        : challenge.status;

    if (!pending) {
      return reply
        .type("text/html")
        .send(
          `<!doctype html><html><body><h2>Challenge ${statusText}.</h2><p>challenge_id=${challenge.id}</p></body></html>`
        );
    }

    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Bloom Step-Up Approval</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; padding: 24px; }
      .card { max-width: 520px; margin: 0 auto; border: 1px solid #ddd; padding: 20px; border-radius: 12px; }
      input { padding: 8px; font-size: 16px; width: 100%; margin-bottom: 12px; }
      button { padding: 10px 16px; font-size: 16px; margin-right: 8px; }
      .meta { color: #555; font-size: 14px; margin-top: 8px; }
      .result { margin-top: 16px; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    </style>
  </head>
  <body>
    <div class="card">
      <h2>Approve spend?</h2>
      <div class="meta">challenge_id=${challenge.id}</div>
      <div class="meta">quote_id=${challenge.quoteId}</div>
      <div class="meta">expires_at=${challenge.expiresAt}</div>
      <label>Human presence code</label>
      <input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" />
      <div>
        <button id="approve">Approve</button>
        <button id="deny">Deny</button>
      </div>
      <div id="result" class="result"></div>
    </div>
    <script>
      const resultEl = document.getElementById("result");
      async function submit(decision) {
        const code = document.getElementById("code").value.trim();
        resultEl.textContent = "Submitting...";
        const res = await fetch("/api/step_up/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            challenge_id: "${challenge.id}",
            decision,
            code
          })
        });
        const text = await res.text();
        resultEl.textContent = text || "ok";
      }
      document.getElementById("approve").addEventListener("click", () => submit("approve"));
      document.getElementById("deny").addEventListener("click", () => submit("deny"));
    </script>
  </body>
</html>`;

    return reply.type("text/html").send(html);
  });

  app.post("/api/step_up/confirm", async (request, reply) => {
    const ip = request.ip ?? request.socket?.remoteAddress ?? "";
    if (ip !== "127.0.0.1") {
      return reply.status(403).send({ error: "forbidden" });
    }
    const body = request.body as { challenge_id?: string; code?: string; decision?: "approve" | "deny" };
    if (!body.challenge_id || !body.code || !body.decision) {
      return reply.status(400).send({ error: "challenge_id_code_decision_required" });
    }
    if (body.decision !== "approve" && body.decision !== "deny") {
      return reply.status(400).send({ error: "invalid_decision" });
    }
    const result = await kernel.confirmStepUpChallenge({
      challenge_id: body.challenge_id,
      code: body.code,
      decision: body.decision
    });
    if (result.ok === false) {
      const error = "reason" in result ? result.reason : "unknown_error";
      return reply.status(400).send({ error });
    }
    return reply.send(result.response);
  });

  return app;
}

async function main() {
  const { app, config, kernel, db } = buildServer();
  if (process.env.NODE_ENV !== "test") {
    // eslint-disable-next-line no-console
    console.log(`DB_PATH=${config.DB_PATH}`);
    // eslint-disable-next-line no-console
    console.log(`CONSOLE_DB_PATH=${config.CONSOLE_DB_PATH}`);
  }
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  if (config.BIND_APPROVAL_UI) {
    const approvalApp = buildApprovalServer({ config, kernel, db });
    await approvalApp.listen({ port: config.APPROVAL_UI_PORT, host: "127.0.0.1" });
  }
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
