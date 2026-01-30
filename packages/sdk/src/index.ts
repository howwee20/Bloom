export type BloomClientOptions = {
  baseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
};

export type CanDoResponse = {
  quote_id: string;
  allowed: boolean;
  requires_step_up: boolean;
  reason: string;
  expires_at: number;
  idempotency_key: string;
};

export type ExecuteResponse = {
  status: "applied" | "failed" | "rejected" | "idempotent";
  exec_id?: string;
  external_ref?: string;
  reason?: string;
};

export type ReceiptsResponse = {
  receipts: Array<{
    receiptId: string;
    agentId: string;
    userId: string;
    source: string;
    eventId: string | null;
    externalRef: string | null;
    whatHappened: string;
    whyChanged: string;
    whatHappensNext: string;
    occurredAt: number;
    createdAt: number;
  }>;
};

type RequestOptions = {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
};

export class BloomClient {
  private baseUrl: string;
  private apiKey: string;
  private fetchFn: typeof fetch;

  constructor(options: BloomClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  setApiKey(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: options.method ?? "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as T) : ({} as T);
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      (err as Error & { response?: T }).response = data;
      throw err;
    }
    return data;
  }

  async createAgent(input: { agent_id?: string; user_id?: string } = {}) {
    return this.request<{ user_id: string; agent_id: string }>("/api/agents", {
      body: input
    });
  }

  async canDo(input: {
    agent_id: string;
    intent_json: Record<string, unknown>;
    idempotency_key?: string;
    user_id?: string;
  }): Promise<CanDoResponse> {
    return this.request<CanDoResponse>("/api/can_do", { body: input });
  }

  async execute(input: {
    quote_id: string;
    idempotency_key: string;
    step_up_token?: string;
    override_freshness?: boolean;
  }): Promise<ExecuteResponse> {
    return this.request<ExecuteResponse>("/api/execute", { body: input });
  }

  async getState(agent_id: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/api/state?agent_id=${encodeURIComponent(agent_id)}`, {
      method: "GET"
    });
  }

  async getReceipts(input: { agent_id: string; since?: number }): Promise<ReceiptsResponse> {
    const qs = new URLSearchParams({ agent_id: input.agent_id });
    if (input.since) qs.set("since", String(input.since));
    return this.request<ReceiptsResponse>(`/api/receipts?${qs.toString()}`, { method: "GET" });
  }
}
