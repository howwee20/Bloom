import fs from "node:fs";

export type Config = {
  API_VERSION: string;
  DB_PATH: string;
  PORT: number;
  APPROVAL_UI_PORT: number;
  BIND_APPROVAL_UI: boolean;
  CARD_MODE: "dev" | "shadow" | "enforce";
  CARD_WEBHOOK_SHARED_SECRET: string | null;
  ADMIN_API_KEY: string | null;
  ENV_TYPE: "simple_economy" | "base_usdc";
  ENV_STALE_SECONDS: number;
  ENV_UNKNOWN_SECONDS: number;
  STEP_UP_SHARED_SECRET: string | null;
  STEP_UP_CHALLENGE_TTL_SECONDS: number;
  STEP_UP_TOKEN_TTL_SECONDS: number;
  DEFAULT_CREDITS_CENTS: number;
  DEFAULT_DAILY_SPEND_CENTS: number;
  BASE_RPC_URL: string | null;
  BASE_CHAIN: "base" | "base_sepolia";
  BASE_USDC_CONTRACT: string | null;
  CONFIRMATIONS_REQUIRED: number;
  USDC_BUFFER_CENTS: number;
  DEV_MASTER_MNEMONIC: string | null;
  BLOOM_ALLOW_TRANSFER: boolean;
  BLOOM_ALLOW_TRANSFER_AGENT_IDS: string[];
  BLOOM_ALLOW_TRANSFER_TO: string[];
  BLOOM_AUTO_APPROVE_TRANSFER_MAX_CENTS: number | null;
  BLOOM_AUTO_APPROVE_AGENT_IDS: string[];
  BLOOM_AUTO_APPROVE_TO: string[];
  BLOOM_ALLOW_POLYMARKET: boolean;
  BLOOM_ALLOW_POLYMARKET_AGENT_IDS: string[];
  POLY_DRYRUN_MAX_PER_ORDER_CENTS: number;
  POLY_DRYRUN_MAX_OPEN_HOLDS_CENTS: number;
  POLY_DRYRUN_MAX_OPEN_ORDERS: number;
  POLY_DRYRUN_LOOP_SECONDS: number;
  POLY_MODE: "dryrun" | "real";
  POLY_CLOB_HOST: string;
  POLY_GAMMA_HOST: string;
  POLY_DATA_HOST: string;
  POLY_CHAIN_ID: number;
  POLY_PRIVATE_KEY: string | null;
  POLY_API_KEY: string | null;
  POLY_API_SECRET: string | null;
  POLY_API_PASSPHRASE: string | null;
  POLY_BOT_AGENT_ID: string;
  POLY_BOT_LOOP_SECONDS: number;
  POLY_BOT_TRADING_ENABLED: boolean;
  // Phase 4: Trading gate limits (real mode)
  POLY_MAX_PER_ORDER_CENTS: number;
  POLY_MAX_PER_DAY_CENTS: number;
  POLY_MAX_OPEN_HOLDS_CENTS: number;
  POLY_MAX_OPEN_ORDERS: number;
  // Phase 4: Bot trading config
  POLY_TRADE_TOKEN_ID: string | null;
  POLY_TRADE_PRICE: number | null;
  POLY_TRADE_SIZE: number | null;
  POLY_MIN_SECONDS_BETWEEN_TRADES: number;
  POLY_TRADE_AUTO_APPROVE: boolean;
  POLY_TRADE_MARKET_SLUG: string | null;
};

function isRunningInDocker() {
  if (process.env.BLOOM_DOCKER === "true" || process.env.DOCKER === "true") return true;
  if (fs.existsSync("/.dockerenv") || fs.existsSync("/.containerenv")) return true;
  try {
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    if (cgroup.includes("docker") || cgroup.includes("containerd") || cgroup.includes("kubepods")) return true;
  } catch {
    // Non-Linux hosts won't have /proc.
  }
  return false;
}

function parseCsv(value: string | undefined | null) {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseOptionalInt(value: string | undefined | null) {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}

export function getConfig(): Config {
  const env = process.env;
  const runningInDocker = isRunningInDocker();
  const defaultDbPath = runningInDocker ? "/data/kernel.db" : "./data/kernel.db";
  const dbPath = env.DB_PATH ?? defaultDbPath;
  if (dbPath === "/data/kernel.db" && !runningInDocker) {
    throw new Error("DB_PATH=/data/kernel.db is reserved for Docker. Use ./data/kernel.db or set BLOOM_DOCKER=true.");
  }
  return {
    API_VERSION: env.API_VERSION ?? "0.1.0-alpha",
    DB_PATH: dbPath,
    PORT: env.PORT ? Number(env.PORT) : 3000,
    APPROVAL_UI_PORT: env.APPROVAL_UI_PORT ? Number(env.APPROVAL_UI_PORT) : 3001,
    BIND_APPROVAL_UI: env.BIND_APPROVAL_UI === "true",
    CARD_MODE: env.CARD_MODE === "shadow" ? "shadow" : env.CARD_MODE === "enforce" ? "enforce" : "dev",
    CARD_WEBHOOK_SHARED_SECRET: env.CARD_WEBHOOK_SHARED_SECRET ?? null,
    ADMIN_API_KEY: env.ADMIN_API_KEY ?? env.BLOOM_ADMIN_KEY ?? null,
    ENV_TYPE: env.ENV_TYPE === "base_usdc" ? "base_usdc" : "simple_economy",
    ENV_STALE_SECONDS: env.ENV_STALE_SECONDS ? Number(env.ENV_STALE_SECONDS) : 60,
    ENV_UNKNOWN_SECONDS: env.ENV_UNKNOWN_SECONDS ? Number(env.ENV_UNKNOWN_SECONDS) : 300,
    STEP_UP_SHARED_SECRET: env.STEP_UP_SHARED_SECRET ?? null,
    STEP_UP_CHALLENGE_TTL_SECONDS: env.STEP_UP_CHALLENGE_TTL_SECONDS
      ? Number(env.STEP_UP_CHALLENGE_TTL_SECONDS)
      : 120,
    STEP_UP_TOKEN_TTL_SECONDS: env.STEP_UP_TOKEN_TTL_SECONDS ? Number(env.STEP_UP_TOKEN_TTL_SECONDS) : 60,
    DEFAULT_CREDITS_CENTS: env.DEFAULT_CREDITS_CENTS ? Number(env.DEFAULT_CREDITS_CENTS) : 5000,
    DEFAULT_DAILY_SPEND_CENTS: env.DEFAULT_DAILY_SPEND_CENTS ? Number(env.DEFAULT_DAILY_SPEND_CENTS) : 2000,
    BASE_RPC_URL: env.BASE_RPC_URL ?? null,
    BASE_CHAIN: env.BASE_CHAIN === "base" ? "base" : "base_sepolia",
    BASE_USDC_CONTRACT: env.BASE_USDC_CONTRACT ?? null,
    CONFIRMATIONS_REQUIRED: env.CONFIRMATIONS_REQUIRED ? Number(env.CONFIRMATIONS_REQUIRED) : 5,
    USDC_BUFFER_CENTS: env.USDC_BUFFER_CENTS ? Number(env.USDC_BUFFER_CENTS) : 0,
    DEV_MASTER_MNEMONIC: env.DEV_MASTER_MNEMONIC ?? null,
    BLOOM_ALLOW_TRANSFER: env.BLOOM_ALLOW_TRANSFER === "true",
    BLOOM_ALLOW_TRANSFER_AGENT_IDS: parseCsv(env.BLOOM_ALLOW_TRANSFER_AGENT_IDS),
    BLOOM_ALLOW_TRANSFER_TO: parseCsv(env.BLOOM_ALLOW_TRANSFER_TO).map((entry) => entry.toLowerCase()),
    BLOOM_AUTO_APPROVE_TRANSFER_MAX_CENTS: parseOptionalInt(env.BLOOM_AUTO_APPROVE_TRANSFER_MAX_CENTS),
    BLOOM_AUTO_APPROVE_AGENT_IDS: parseCsv(env.BLOOM_AUTO_APPROVE_AGENT_IDS),
    BLOOM_AUTO_APPROVE_TO: parseCsv(env.BLOOM_AUTO_APPROVE_TO).map((entry) => entry.toLowerCase()),
    BLOOM_ALLOW_POLYMARKET: env.BLOOM_ALLOW_POLYMARKET === "true",
    BLOOM_ALLOW_POLYMARKET_AGENT_IDS: parseCsv(env.BLOOM_ALLOW_POLYMARKET_AGENT_IDS),
    POLY_DRYRUN_MAX_PER_ORDER_CENTS: env.POLY_DRYRUN_MAX_PER_ORDER_CENTS
      ? Number(env.POLY_DRYRUN_MAX_PER_ORDER_CENTS)
      : 500,
    POLY_DRYRUN_MAX_OPEN_HOLDS_CENTS: env.POLY_DRYRUN_MAX_OPEN_HOLDS_CENTS
      ? Number(env.POLY_DRYRUN_MAX_OPEN_HOLDS_CENTS)
      : 2000,
    POLY_DRYRUN_MAX_OPEN_ORDERS: env.POLY_DRYRUN_MAX_OPEN_ORDERS ? Number(env.POLY_DRYRUN_MAX_OPEN_ORDERS) : 20,
    POLY_DRYRUN_LOOP_SECONDS: env.POLY_DRYRUN_LOOP_SECONDS ? Number(env.POLY_DRYRUN_LOOP_SECONDS) : 30,
    POLY_MODE: env.POLY_MODE === "real" ? "real" : "dryrun",
    POLY_CLOB_HOST: env.POLY_CLOB_HOST ?? "https://clob.polymarket.com",
    POLY_GAMMA_HOST: env.POLY_GAMMA_HOST ?? "https://gamma-api.polymarket.com",
    POLY_DATA_HOST: env.POLY_DATA_HOST ?? "https://data-api.polymarket.com",
    POLY_CHAIN_ID: env.POLY_CHAIN_ID ? Number(env.POLY_CHAIN_ID) : 137,
    POLY_PRIVATE_KEY: env.POLY_PRIVATE_KEY ?? null,
    POLY_API_KEY: env.POLY_API_KEY ?? null,
    POLY_API_SECRET: env.POLY_API_SECRET ?? null,
    POLY_API_PASSPHRASE: env.POLY_API_PASSPHRASE ?? null,
    POLY_BOT_AGENT_ID: env.POLY_BOT_AGENT_ID ?? "agent_ej",
    POLY_BOT_LOOP_SECONDS: env.POLY_BOT_LOOP_SECONDS ? Number(env.POLY_BOT_LOOP_SECONDS) : 60,
    POLY_BOT_TRADING_ENABLED: env.POLY_BOT_TRADING_ENABLED === "true",
    // Phase 4: Trading gate limits (real mode) - safe defaults
    POLY_MAX_PER_ORDER_CENTS: env.POLY_MAX_PER_ORDER_CENTS ? Number(env.POLY_MAX_PER_ORDER_CENTS) : 10,
    POLY_MAX_PER_DAY_CENTS: env.POLY_MAX_PER_DAY_CENTS ? Number(env.POLY_MAX_PER_DAY_CENTS) : 0, // 0 = disabled
    POLY_MAX_OPEN_HOLDS_CENTS: env.POLY_MAX_OPEN_HOLDS_CENTS ? Number(env.POLY_MAX_OPEN_HOLDS_CENTS) : 20,
    POLY_MAX_OPEN_ORDERS: env.POLY_MAX_OPEN_ORDERS ? Number(env.POLY_MAX_OPEN_ORDERS) : 5,
    // Phase 4: Bot trading config
    POLY_TRADE_TOKEN_ID: env.POLY_TRADE_TOKEN_ID ?? null,
    POLY_TRADE_PRICE: env.POLY_TRADE_PRICE ? Number(env.POLY_TRADE_PRICE) : null,
    POLY_TRADE_SIZE: env.POLY_TRADE_SIZE ? Number(env.POLY_TRADE_SIZE) : null,
    POLY_MIN_SECONDS_BETWEEN_TRADES: env.POLY_MIN_SECONDS_BETWEEN_TRADES
      ? Number(env.POLY_MIN_SECONDS_BETWEEN_TRADES)
      : 3600,
    POLY_TRADE_AUTO_APPROVE: env.POLY_TRADE_AUTO_APPROVE === "true",
    POLY_TRADE_MARKET_SLUG: env.POLY_TRADE_MARKET_SLUG ?? null
  };
}
