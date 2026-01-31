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
};

export function getConfig(): Config {
  const env = process.env;
  return {
    API_VERSION: env.API_VERSION ?? "0.1.0-alpha",
    DB_PATH: env.DB_PATH ?? "./data/kernel.db",
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
    DEV_MASTER_MNEMONIC: env.DEV_MASTER_MNEMONIC ?? null
  };
}
