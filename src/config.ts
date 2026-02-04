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
  // Console (reference client)
  ANTHROPIC_API_KEY: string | null;
  ANTHROPIC_MODEL: string;
  CONSOLE_BOOTSTRAP_TOKEN: string | null;
  CONSOLE_PASSWORD: string | null;
  CONSOLE_SESSION_TTL_SECONDS: number;
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
    ADMIN_API_KEY: env.ADMIN_API_KEY ?? null,
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
    // Console (reference client)
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? null,
    ANTHROPIC_MODEL: env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-20240620",
    CONSOLE_BOOTSTRAP_TOKEN: env.CONSOLE_BOOTSTRAP_TOKEN ?? null,
    CONSOLE_PASSWORD: env.CONSOLE_PASSWORD ?? null,
    CONSOLE_SESSION_TTL_SECONDS: env.CONSOLE_SESSION_TTL_SECONDS
      ? Number(env.CONSOLE_SESSION_TTL_SECONDS)
      : 12 * 60 * 60
  };
}
