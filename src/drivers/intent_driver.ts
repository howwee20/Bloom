import type Database from "better-sqlite3";
import type { DbClient } from "../db/database.js";
import type { Config } from "../config.js";
import type { IEnvironment } from "../env/IEnvironment.js";
import type { budgets, quotes } from "../db/schema.js";

export type DriverExecuteRequest = {
  quote_id: string;
  idempotency_key: string;
  step_up_token?: string;
  override_freshness?: boolean;
};

export type DriverExecuteResponse = {
  status: "applied" | "failed" | "rejected" | "idempotent";
  exec_id?: string;
  external_ref?: string;
  reason?: string;
};

export type DriverDecision = {
  allowed: boolean;
  reason: string;
  requires_step_up?: boolean;
  spend_power?: Record<string, unknown>;
  facts_snapshot?: Record<string, unknown>;
};

export type DriverPreConstraintsContext = {
  db: DbClient;
  sqlite: Database;
  config: Config;
  env: IEnvironment;
  agentId: string;
  userId: string;
  intent: Record<string, unknown>;
  intentType: string;
};

export type DriverBudgetContext = DriverPreConstraintsContext & {
  budget: typeof budgets.$inferSelect;
  policySpendableCents: number;
  reservedOutgoingCents: number;
  reservedHoldsCents: number;
  factsSnapshotBase: Record<string, unknown>;
};

export type DriverExecuteContext = {
  db: DbClient;
  sqlite: Database;
  config: Config;
  env: IEnvironment;
  quote: typeof quotes.$inferSelect;
  intent: Record<string, unknown>;
  input: DriverExecuteRequest;
};

export type DriverNormalizeResult =
  | { ok: true; intent: Record<string, unknown> }
  | { ok: false; reason: string };

export interface IntentDriver {
  supports(intentType: string): boolean;
  normalizeIntent?(intent: Record<string, unknown>): DriverNormalizeResult;
  getIntentCost?(intent: Record<string, unknown>): { baseCost: number; transferAmount: number } | null;
  preConstraints?(ctx: DriverPreConstraintsContext): Promise<DriverDecision> | DriverDecision;
  postBudgetConstraints?(ctx: DriverBudgetContext): Promise<DriverDecision> | DriverDecision;
  execute?(ctx: DriverExecuteContext): Promise<DriverExecuteResponse> | DriverExecuteResponse;
}
