import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createDatabase } from "../db/database.js";
import { getConfig } from "../config.js";
import { Kernel } from "../kernel/kernel.js";
import { SimpleEconomyWorld } from "../env/simple_economy.js";
import { BaseUsdcWorld } from "../env/base_usdc.js";
import { agentTokens, agents, apiKeys, budgets, quotes, users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type { DbClient } from "../db/database.js";
import type Database from "better-sqlite3";
import type { IEnvironment } from "../env/IEnvironment.js";
import { newId, nowSeconds } from "../kernel/utils.js";

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
  const kernel = new Kernel(db, sqlite, env, config);

  const app = Fastify({ logger: true });

  const rateBuckets = new Map<string, { count: number; resetAt: number }>();
  const RATE_LIMIT_WINDOW_SECONDS = 60;
  const RATE_LIMIT_MAX_PER_KEY = 60;
  const RATE_LIMIT_MAX_PER_IP = 120;

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

  app.post("/api/agents", async (request, reply) => {
    const body = (request.body ?? {}) as { user_id?: string; agent_id?: string };
    const authUser = request.authUser;
    if (!authUser) return reply.status(401).send({ error: "api_key_required" });
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
    const authUser = request.authUser;
    if (!authUser) return reply.status(401).send({ error: "api_key_required" });
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
    const authUser = request.authUser;
    if (!authUser) return reply.status(401).send({ error: "api_key_required" });
    const quote = db.select().from(quotes).where(eq(quotes.quoteId, body.quote_id)).get();
    if (quote && quote.userId !== authUser.userId) {
      return reply.status(403).send({ error: "forbidden" });
    }
    const result = await kernel.execute(body);
    return reply.send(result);
  });

  app.get("/api/state", async (request, reply) => {
    const query = request.query as { agent_id?: string };
    if (!query.agent_id) return reply.status(400).send({ error: "agent_id_required" });
    const authUser = request.authUser;
    if (!authUser) return reply.status(401).send({ error: "api_key_required" });
    const ownership = ensureAgentOwnership(db, query.agent_id, authUser.userId);
    if (!ownership.ok) return reply.status(ownership.statusCode).send({ error: ownership.error });
    const state = await kernel.getState(query.agent_id);
    return reply.send(state);
  });

  app.get("/api/receipts", async (request, reply) => {
    const query = request.query as { agent_id?: string; since?: string };
    if (!query.agent_id) return reply.status(400).send({ error: "agent_id_required" });
    const authUser = request.authUser;
    if (!authUser) return reply.status(401).send({ error: "api_key_required" });
    const ownership = ensureAgentOwnership(db, query.agent_id, authUser.userId);
    if (!ownership.ok) return reply.status(ownership.statusCode).send({ error: ownership.error });
    const since = query.since ? Number(query.since) : undefined;
    const rows = kernel.getReceipts(query.agent_id, since);
    return reply.send({ receipts: rows });
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

async function main() {
  const { app, config } = buildServer();
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
