export type EnvFreshnessStatus = "fresh" | "stale" | "unknown";

export type EnvFreshness = {
  status: EnvFreshnessStatus;
  updated_ago_seconds: number;
  details?: string;
};

export type EnvEvent = {
  type: string;
  payload: Record<string, unknown>;
  cost_delta_cents?: number;
  transfer?: { to_agent_id: string; amount_cents: number };
};

export type EnvResult = {
  ok: boolean;
  envEvents: EnvEvent[];
  external_ref?: string;
};

export type EnvObservation = Record<string, unknown>;

export interface IEnvironment {
  envName: string;
  getObservation(agentId: string): Promise<EnvObservation>;
  applyAction(agentId: string, intent: Record<string, unknown>): EnvResult;
  getFreshness(): Promise<EnvFreshness>;
}
