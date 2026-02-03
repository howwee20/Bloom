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
import {
  agentSpendSnapshot,
  agentTokens,
  agents,
  apiKeys,
  budgets,
  cardHolds,
  executions,
  events,
  policies,
  quotes,
  receipts,
  stepUpChallenges,
  users
} from "../db/schema.js";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbClient } from "../db/database.js";
import Database from "better-sqlite3";
import type { IEnvironment } from "../env/IEnvironment.js";
import { newId, nowSeconds } from "../kernel/utils.js";
import { appendEvent } from "../kernel/events.js";
import { createReceipt } from "../kernel/receipts.js";
import { refreshAgentSpendSnapshot } from "../kernel/spend_snapshot.js";
import { CARD_SIGNATURE_HEADER, CARD_TIMESTAMP_HEADER, verifyCardSignature } from "./card_webhook.js";
import { PolymarketBot } from "../bots/polymarket_bot.js";
import { PolymarketDryrunBot } from "../bots/polymarket_dryrun_bot.js";
import { PolymarketDryrunDriver } from "../drivers/polymarket_dryrun_driver.js";
import { PolymarketRealDriver } from "../drivers/polymarket_real_driver.js";
import { buildUiActivity, formatMoney, formatUpdated } from "../presentation/index.js";
import { reconcilePolymarketOrders } from "../polymarket/reconcile.js";

type AuthUser = {
  userId: string;
  keyId: string;
  scopes: string[];
};

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
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

const TX_HASH_REGEX = /tx_hash=([0-9a-fA-Fx]+)/;

function extractTxHash(what: string | null | undefined) {
  if (!what) return undefined;
  const match = TX_HASH_REGEX.exec(what);
  return match?.[1];
}

function normalizeQuoteId(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeTransferIntentType(intent: Record<string, unknown>) {
  const raw = String(intent.type ?? "");
  if (raw === "send_usdc" || raw === "base_usdc_transfer" || raw === "base_usdc_send") return "usdc_transfer";
  return raw;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isAutoApproveTransfer(config: ReturnType<typeof getConfig>, agentId: string, intent: Record<string, unknown>) {
  if (config.ENV_TYPE !== "base_usdc") return false;
  if (normalizeTransferIntentType(intent) !== "usdc_transfer") return false;
  if (!config.BLOOM_AUTO_APPROVE_TRANSFER_MAX_CENTS || config.BLOOM_AUTO_APPROVE_TRANSFER_MAX_CENTS <= 0) return false;
  if (!config.BLOOM_AUTO_APPROVE_AGENT_IDS.includes(agentId)) return false;
  const toAddress = String(intent.to_address ?? "").trim().toLowerCase();
  if (!toAddress) return false;
  if (config.BLOOM_AUTO_APPROVE_TO.length > 0 && !config.BLOOM_AUTO_APPROVE_TO.includes(toAddress)) return false;
  const amount = toFiniteNumber(intent.amount_cents);
  if (amount === null || !Number.isInteger(amount) || amount <= 0) return false;
  return amount <= config.BLOOM_AUTO_APPROVE_TRANSFER_MAX_CENTS;
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
  env?: IEnvironment;
} = {}) {
  const config = options.config ?? getConfig();
  if (config.DB_PATH !== ":memory:" && config.DB_PATH !== "file::memory:") {
    ensureDbPath(config.DB_PATH);
  }
  const { sqlite, db } =
    options.db && options.sqlite
      ? { sqlite: options.sqlite, db: options.db }
      : createDatabase(config.DB_PATH);
  const env =
    options.env ??
    (config.ENV_TYPE === "base_usdc"
      ? new BaseUsdcWorld(db, sqlite, config)
      : new SimpleEconomyWorld(db, sqlite, config));
  const polymarketDriver =
    config.POLY_MODE === "real" ? new PolymarketRealDriver() : new PolymarketDryrunDriver();
  const kernel = new Kernel(db, sqlite, env, config, [polymarketDriver]);
  const polymarketDryrunBot = new PolymarketDryrunBot(db, sqlite, config);
  const polymarketBot = new PolymarketBot(db, sqlite, config);

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
    const configAuth = request.routeOptions.config as { auth?: "admin" | "public" | "user" } | undefined;
    const authMode = configAuth?.auth ?? "user";
    if (authMode === "admin" || authMode === "public") return;

    const now = nowSeconds();
    const ipKey = `ip:${request.ip ?? "unknown"}`;
    if (!consumeRate(ipKey, RATE_LIMIT_MAX_PER_IP, now)) {
      reply.status(429).send({ error: "rate_limited" });
      return;
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

  app.post("/api/auto_execute", async (request, reply) => {
    const body = request.body as {
      user_id?: string;
      agent_id?: string;
      intent_json?: Record<string, unknown>;
      idempotency_key?: string;
    };
    if (!body.agent_id || !body.intent_json) {
      return reply.status(400).send({ error: "agent_id_and_intent_json_required" });
    }
    if (!requireScope(request, reply, "propose")) return;
    const authUser = request.authUser as AuthUser;
    if (body.user_id && body.user_id !== authUser.userId) {
      return reply.status(403).send({ error: "forbidden" });
    }
    const ownership = ensureAgentOwnership(db, body.agent_id, authUser.userId);
    if (!ownership.ok) return reply.status(ownership.statusCode).send({ error: ownership.error });

    const intentType = normalizeTransferIntentType(body.intent_json);
    const isPolymarket =
      intentType === "polymarket_place_order" || intentType === "polymarket_cancel_order";
    if (intentType !== "usdc_transfer" && !isPolymarket) {
      return reply.status(400).send({ error: "unsupported_intent" });
    }

    const quote = await kernel.canDo({
      agent_id: body.agent_id,
      user_id: authUser.userId,
      intent_json: body.intent_json,
      idempotency_key: body.idempotency_key
    });

    if (!quote.allowed) {
      return reply.send({ quote, execution: null, auto_approved: false, step_up_required: false });
    }

    if (quote.requires_step_up) {
      if (intentType !== "usdc_transfer") {
        return reply.send({ quote, execution: null, auto_approved: false, step_up_required: true });
      }
      if (!isAutoApproveTransfer(config, body.agent_id, body.intent_json)) {
        return reply.send({ quote, execution: null, auto_approved: false, step_up_required: true });
      }

      const challenge = await kernel.requestStepUpChallenge({
        user_id: authUser.userId,
        agent_id: body.agent_id,
        quote_id: quote.quote_id
      });
      if (!challenge.code) {
        return reply.send({ quote, execution: null, auto_approved: false, step_up_required: true });
      }
      const approval = await kernel.confirmStepUpChallenge({
        challenge_id: challenge.challenge_id,
        code: challenge.code,
        decision: "approve"
      });
      if (!approval.ok || approval.response.status !== "approved" || !approval.response.step_up_token) {
        return reply
          .status(400)
          .send({ error: approval.ok ? "step_up_denied" : approval.reason, quote });
      }

      const execution = await kernel.execute({
        quote_id: quote.quote_id,
        idempotency_key: quote.idempotency_key,
        step_up_token: approval.response.step_up_token
      });
      return reply.send({ quote, execution, auto_approved: true, step_up_required: false });
    }

    const execution = await kernel.execute({
      quote_id: quote.quote_id,
      idempotency_key: quote.idempotency_key
    });
    return reply.send({ quote, execution, auto_approved: false, step_up_required: false });
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

  app.post("/api/bots/polymarket_dryrun/start", { config: { auth: "admin" } }, async (request, reply) => {
    if (!requireAdminKey(config, request, reply)) return;
    const body = (request.body ?? {}) as { agent_id?: string };
    const agentId = String(body.agent_id ?? "").trim();
    if (!agentId) return reply.status(400).send({ error: "agent_id_required" });
    try {
      const status = polymarketDryrunBot.start(agentId);
      return reply.send(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid_request";
      return reply.status(400).send({ error: message });
    }
  });

  app.post("/api/bots/polymarket_dryrun/stop", { config: { auth: "admin" } }, async (request, reply) => {
    if (!requireAdminKey(config, request, reply)) return;
    const status = polymarketDryrunBot.stop();
    return reply.send(status);
  });

  app.get("/api/bots/polymarket_dryrun/status", async (request, reply) => {
    if (!requireScope(request, reply, "read")) return;
    return reply.send(polymarketDryrunBot.status());
  });

  app.post("/api/bots/polymarket/start", { config: { auth: "admin" } }, async (request, reply) => {
    if (!requireAdminKey(config, request, reply)) return;
    const body = (request.body ?? {}) as { agent_id?: string };
    const agentIdRaw = body.agent_id ? String(body.agent_id).trim() : "";
    try {
      const status = await polymarketBot.start(agentIdRaw || undefined);
      return reply.send(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid_request";
      return reply.status(400).send({ error: message });
    }
  });

  app.post("/api/bots/polymarket/stop", { config: { auth: "admin" } }, async (request, reply) => {
    if (!requireAdminKey(config, request, reply)) return;
    const status = polymarketBot.stop();
    return reply.send(status);
  });

  app.get("/api/bots/polymarket/status", async (request, reply) => {
    if (!requireScope(request, reply, "read")) return;
    return reply.send(polymarketBot.status());
  });

  app.post("/api/bots/polymarket/kill", { config: { auth: "admin" } }, async (request, reply) => {
    if (!requireAdminKey(config, request, reply)) return;
    const body = (request.body ?? {}) as { cancel_orders?: boolean };
    const cancelOrders = body.cancel_orders === true;
    try {
      const result = await polymarketBot.kill({ db, sqlite, cancelOrders });
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "kill_failed";
      return reply.status(500).send({ error: message });
    }
  });

  app.post("/api/polymarket/reconcile", { config: { auth: "admin" } }, async (request, reply) => {
    if (!requireAdminKey(config, request, reply)) return;
    const result = await reconcilePolymarketOrders({ db, sqlite, config });
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

  app.post("/api/step_up/approve", { config: { auth: "admin" } }, async (request, reply) => {
    if (!requireAdminKey(config, request, reply)) return;
    const body = (request.body ?? {}) as { quote_id?: string; approve?: boolean };
    if (!body.quote_id) return reply.status(400).send({ error: "quote_id_required" });
    const quote = db.select().from(quotes).where(eq(quotes.quoteId, body.quote_id)).get();
    if (!quote) return reply.status(404).send({ error: "quote_not_found" });
    if (quote.requiresStepUp !== 1) return reply.status(400).send({ error: "step_up_not_required" });

    const decision = body.approve === false ? "deny" : "approve";
    const challenge = await kernel.requestStepUpChallenge({
      user_id: quote.userId,
      agent_id: quote.agentId,
      quote_id: quote.quoteId
    });
    if (!challenge.code) return reply.status(409).send({ error: "step_up_pending" });

    const approval = await kernel.confirmStepUpChallenge({
      challenge_id: challenge.challenge_id,
      code: challenge.code,
      decision
    });
    if (!approval.ok) return reply.status(400).send({ error: approval.reason });

    if (approval.response.status === "approved") {
      return reply.send({
        status: "approved",
        step_up_token: approval.response.step_up_token,
        expires_at: approval.response.expires_at
      });
    }
    return reply.send({ status: "denied" });
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

  app.get("/api/ui/state", async (request, reply) => {
    const query = request.query as { agent_id?: string };
    if (!query.agent_id) return reply.status(400).send({ error: "agent_id_required" });
    if (!requireScope(request, reply, "read")) return;
    const authUser = request.authUser as AuthUser;
    const ownership = ensureAgentOwnership(db, query.agent_id, authUser.userId);
    if (!ownership.ok) return reply.status(ownership.statusCode).send({ error: ownership.error });

    const snapshot =
      refreshAgentSpendSnapshot({ db, sqlite, config, agentId: query.agent_id }) ??
      (db.select().from(agentSpendSnapshot).where(eq(agentSpendSnapshot.agentId, query.agent_id)).get() as
        | typeof agentSpendSnapshot.$inferSelect
        | undefined);

    const balanceCents = snapshot?.confirmedBalanceCents ?? 0;
    const heldCents =
      (snapshot?.reservedOutgoingCents ?? 0) +
      (snapshot?.reservedHoldsCents ?? 0) +
      config.USDC_BUFFER_CENTS;
    const spendableCents = snapshot?.effectiveSpendPowerCents ?? 0;
    const updatedAt = snapshot?.updatedAt ?? nowSeconds();
    const now = nowSeconds();
    const botStatus = config.POLY_MODE === "real" ? polymarketBot.status() : polymarketDryrunBot.status();
    const botRunning = botStatus.running;
    const tradingEnabled = config.POLY_MODE === "real" ? botStatus.trading_enabled : false;
    const nextTickAt = botStatus.next_tick_at;
    const lastTickAt = botStatus.last_tick_at;

    return reply.send({
      agent_id: query.agent_id,
      number: formatMoney(spendableCents),
      balance: `${formatMoney(balanceCents)} balance`,
      held: `${formatMoney(heldCents)} held`,
      net_worth: formatMoney(balanceCents),
      updated: formatUpdated(updatedAt, now),
      bot_running: botRunning,
      trading_enabled: tradingEnabled,
      next_tick_at: nextTickAt,
      last_tick_at: lastTickAt,
      details: {
        spendable_cents: spendableCents,
        balance_cents: balanceCents,
        held_cents: heldCents
      }
    });
  });

  app.get("/api/ui/activity", async (request, reply) => {
    const query = request.query as { agent_id?: string; limit?: string; mode?: string };
    if (!query.agent_id) return reply.status(400).send({ error: "agent_id_required" });
    if (!requireScope(request, reply, "read")) return;
    const authUser = request.authUser as AuthUser;
    const ownership = ensureAgentOwnership(db, query.agent_id, authUser.userId);
    if (!ownership.ok) return reply.status(ownership.statusCode).send({ error: ownership.error });

    if (query.mode === "full") {
      const rows = kernel.getReceipts(query.agent_id);
      return reply.send({ receipts: rows });
    }

    const limit = query.limit ? Number(query.limit) : 20;
    const bounded = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
    const receiptLimit = Math.min(500, Math.max(200, bounded * 20));

    const rows = db
      .select()
      .from(receipts)
      .where(eq(receipts.agentId, query.agent_id))
      .orderBy(desc(receipts.createdAt))
      .limit(receiptLimit)
      .all();

    const eventIds = rows.map((row) => row.eventId).filter((eventId): eventId is string => Boolean(eventId));
    const quoteIdByEvent = new Map<string, string>();
    if (eventIds.length > 0) {
      const eventRows = db.select().from(events).where(inArray(events.eventId, eventIds)).all();
      for (const event of eventRows) {
        const payload = parseJson<Record<string, unknown>>(event.payloadJson, {});
        const quoteId = normalizeQuoteId((payload as { quote_id?: unknown }).quote_id);
        if (quoteId) {
          quoteIdByEvent.set(event.eventId, quoteId);
        }
      }
    }

    const externalRefs = rows.map((row) => row.externalRef).filter((ref): ref is string => Boolean(ref));
    const quoteIdByExternalRef = new Map<string, string>();
    if (externalRefs.length > 0) {
      const quoteRows = db.select().from(quotes).where(inArray(quotes.quoteId, externalRefs)).all();
      for (const quote of quoteRows) {
        quoteIdByExternalRef.set(quote.quoteId, quote.quoteId);
      }
      const executionRows = db.select().from(executions).where(inArray(executions.externalRef, externalRefs)).all();
      for (const execution of executionRows) {
        if (execution.externalRef) {
          quoteIdByExternalRef.set(execution.externalRef, execution.quoteId);
        }
      }
    }

    const enriched = rows.map((row) => {
      const txHash = extractTxHash(row.whatHappened);
      const quoteId =
        (row.eventId ? quoteIdByEvent.get(row.eventId) : undefined) ??
        (row.externalRef ? quoteIdByExternalRef.get(row.externalRef) : undefined);
      return { row, txHash, quoteId };
    });

    const txHashByQuoteId = new Map<string, string>();
    for (const entry of enriched) {
      if (entry.txHash && entry.quoteId) {
        txHashByQuoteId.set(entry.quoteId, entry.txHash);
      }
    }

    type ReceiptWithGroupKey = (typeof receipts.$inferSelect) & { groupKey?: string; quoteId?: string | null };
    const rowsWithGroupKey: ReceiptWithGroupKey[] = enriched.map(({ row, txHash, quoteId }) => {
      const mappedTxHash = quoteId ? txHashByQuoteId.get(quoteId) : undefined;
      const groupKey = txHash ?? mappedTxHash ?? quoteId ?? row.receiptId;
      return { ...row, groupKey, quoteId: quoteId ?? null };
    });

    const activity = buildUiActivity(rowsWithGroupKey, { limit: bounded, nowSeconds: nowSeconds() });
    return reply.send(activity);
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

  return { app, kernel, env, db, sqlite, config };
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
    if (!result.ok) {
      return reply.status(400).send({ error: result.reason });
    }
    return reply.send(result.response);
  });

  return app;
}

async function main() {
  const { app, config, kernel, db } = buildServer();
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
