import { useCallback, useEffect, useMemo, useState } from "react";

const DEFAULT_AGENT_ID = "agent_ej";

type UiState = {
  agent_id: string;
  number: string;
  balance: string;
  held: string;
  net_worth: string;
  updated: string;
  bot_running: boolean;
  trading_enabled: boolean;
  next_tick_at: number | null;
  last_tick_at: number | null;
  details: {
    spendable_cents: number;
    balance_cents: number;
    held_cents: number;
  };
};

type UiActivityItem = {
  id: string;
  line: string;
  status: "pending" | "confirmed" | "declined";
  when: string;
  summary: string[];
  details: {
    tx_hash?: string;
    to?: string;
    amount?: string;
  };
};

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

function formatTick(epochSeconds: number | null | undefined) {
  if (!epochSeconds) return "—";
  const date = new Date(epochSeconds * 1000);
  const time = date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${time} · ${day}`;
}

function statusClass(status: UiActivityItem["status"]) {
  if (status === "confirmed") return "status status--confirmed";
  if (status === "declined") return "status status--declined";
  return "status status--pending";
}

export default function App() {
  const [agentId, setAgentId] = useState(DEFAULT_AGENT_ID);
  const [draftAgentId, setDraftAgentId] = useState(DEFAULT_AGENT_ID);
  const [state, setState] = useState<UiState | null>(null);
  const [activity, setActivity] = useState<UiActivityItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshIndex, setRefreshIndex] = useState(0);

  const load = useCallback(async (id: string, signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const [stateData, activityData] = await Promise.all([
        fetchJson<UiState>(`/api/ui/state?agent_id=${encodeURIComponent(id)}`, signal),
        fetchJson<UiActivityItem[]>(
          `/api/ui/activity?agent_id=${encodeURIComponent(id)}&limit=10`,
          signal
        )
      ]);
      setState(stateData);
      setActivity(activityData);
    } catch (err) {
      if (signal?.aborted) return;
      const message = err instanceof Error ? err.message : "Request failed";
      setError(message);
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(agentId, controller.signal);
    return () => controller.abort();
  }, [agentId, refreshIndex, load]);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = draftAgentId.trim();
    setAgentId(trimmed.length > 0 ? trimmed : DEFAULT_AGENT_ID);
  };

  const handleRefresh = () => {
    setRefreshIndex((prev) => prev + 1);
  };

  const activityItems = useMemo(() => activity.slice(0, 10), [activity]);

  return (
    <div className="page">
      <header className="header">
        <div>
          <p className="eyebrow">Bloom</p>
          <h1>Spend Power Console</h1>
          <p className="subhead">Read-only signal stack for the active agent.</p>
        </div>
        <form className="agent-form" onSubmit={handleSubmit}>
          <label className="field">
            <span>Agent ID</span>
            <input
              value={draftAgentId}
              onChange={(event) => setDraftAgentId(event.target.value)}
              placeholder="agent_ej"
              spellCheck={false}
            />
          </label>
          <div className="button-row">
            <button type="submit">Load</button>
            <button type="button" className="ghost" onClick={handleRefresh}>
              Refresh
            </button>
          </div>
        </form>
      </header>

      <main className="grid">
        <section className="card card--hero">
          <p className="card-label">Spend Power</p>
          <div className="big-number">{state?.number ?? "—"}</div>
          <div className="meta">
            <span>Agent: {state?.agent_id ?? agentId}</span>
            <span>Updated {state?.updated ?? "—"}</span>
          </div>
        </section>

        <section className="card card--stats">
          <div>
            <p className="card-label">Balance</p>
            <p className="stat">{state?.balance ?? "—"}</p>
          </div>
          <div>
            <p className="card-label">Held</p>
            <p className="stat">{state?.held ?? "—"}</p>
          </div>
          <div>
            <p className="card-label">Net Worth</p>
            <p className="stat">{state?.net_worth ?? "—"}</p>
          </div>
        </section>

        <section className="card card--bot">
          <div className="bot-row">
            <div>
              <p className="card-label">Bot Running</p>
              <p className={state?.bot_running ? "pill pill--on" : "pill pill--off"}>
                {state?.bot_running ? "Running" : "Stopped"}
              </p>
            </div>
            <div>
              <p className="card-label">Trading</p>
              <p className={state?.trading_enabled ? "pill pill--on" : "pill pill--off"}>
                {state?.trading_enabled ? "Enabled" : "Disabled"}
              </p>
            </div>
          </div>
          <div className="bot-row">
            <div>
              <p className="card-label">Next Tick</p>
              <p className="stat small">{formatTick(state?.next_tick_at)}</p>
            </div>
            <div>
              <p className="card-label">Last Tick</p>
              <p className="stat small">{formatTick(state?.last_tick_at)}</p>
            </div>
          </div>
        </section>

        <section className="card card--activity">
          <div className="activity-head">
            <div>
              <h2>Activity</h2>
              <p className="subhead">Latest 10 grouped actions.</p>
            </div>
            {loading ? <span className="status status--pending">Loading</span> : null}
          </div>

          {error ? <div className="error">{error}</div> : null}

          {activityItems.length === 0 && !loading ? (
            <div className="empty">No activity yet.</div>
          ) : (
            <ul className="activity-list">
              {activityItems.map((item) => (
                <li key={item.id} className="activity-item">
                  <div className="activity-line">
                    <div>
                      <p className="line">{item.line}</p>
                      <p className="when">{item.when}</p>
                    </div>
                    <span className={statusClass(item.status)}>{item.status}</span>
                  </div>
                  <div className="activity-details">
                    <div className="summary">
                      {item.summary.map((step, index) => (
                        <span key={`${item.id}-step-${index}`}>{step}</span>
                      ))}
                    </div>
                    <div className="meta">
                      {item.details.amount ? <span>{item.details.amount}</span> : null}
                      {item.details.to ? <span>to {item.details.to}</span> : null}
                      {item.details.tx_hash ? <span>tx {item.details.tx_hash}</span> : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
