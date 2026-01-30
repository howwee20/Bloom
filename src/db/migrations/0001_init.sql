PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','frozen','dead')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS agent_tokens (
  token_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS policies (
  policy_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  per_intent_limit_json TEXT NOT NULL,
  daily_limit_json TEXT NOT NULL,
  allowlist_json TEXT NOT NULL,
  blocklist_json TEXT NOT NULL,
  step_up_threshold_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

CREATE TABLE IF NOT EXISTS budgets (
  agent_id TEXT PRIMARY KEY,
  credits_cents INTEGER NOT NULL,
  daily_spend_cents INTEGER NOT NULL,
  daily_spend_used_cents INTEGER NOT NULL,
  last_reset_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

CREATE TABLE IF NOT EXISTS quotes (
  quote_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  allowed INTEGER NOT NULL CHECK (allowed IN (0,1)),
  requires_step_up INTEGER NOT NULL CHECK (requires_step_up IN (0,1)),
  reason TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS quotes_agent_idem_unique ON quotes(agent_id, idempotency_key);

CREATE TABLE IF NOT EXISTS executions (
  exec_id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','applied','failed','canceled')),
  external_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (quote_id) REFERENCES quotes(quote_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS executions_quote_unique ON executions(quote_id);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  hash TEXT NOT NULL,
  prev_hash TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TRIGGER IF NOT EXISTS events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(FAIL, 'events table is append-only');
END;

CREATE TRIGGER IF NOT EXISTS events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(FAIL, 'events table is append-only');
END;

CREATE TABLE IF NOT EXISTS receipts (
  receipt_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('policy','execution','env','repair')),
  event_id TEXT,
  external_ref TEXT,
  what_happened TEXT NOT NULL,
  why_changed TEXT NOT NULL,
  what_happens_next TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (event_id) REFERENCES events(event_id)
);

CREATE TABLE IF NOT EXISTS env_health (
  env_name TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('fresh','stale','unknown')),
  last_ok_at INTEGER,
  last_tick_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- Simple Economy World tables
CREATE TABLE IF NOT EXISTS economy_prices (
  price_key TEXT PRIMARY KEY,
  price_cents INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS economy_jobs (
  job_id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt TEXT NOT NULL,
  correct_answer TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','completed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS economy_completed_jobs (
  completed_id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  answer TEXT NOT NULL,
  confidence REAL NOT NULL,
  correct INTEGER NOT NULL CHECK (correct IN (0,1)),
  reward_cents INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES economy_jobs(job_id),
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

CREATE TABLE IF NOT EXISTS economy_tools (
  tool_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS economy_agent_tools (
  agent_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, tool_id),
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id),
  FOREIGN KEY (tool_id) REFERENCES economy_tools(tool_id)
);

CREATE TABLE IF NOT EXISTS economy_agent_state (
  agent_id TEXT PRIMARY KEY,
  calibration_score REAL NOT NULL,
  last_observation_at INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

CREATE TABLE IF NOT EXISTS economy_action_dedup (
  external_ref TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

-- Seed baseline prices/tools if empty
INSERT INTO economy_prices (price_key, price_cents, updated_at)
SELECT 'request_job_cost', 25, strftime('%s','now')
WHERE NOT EXISTS (SELECT 1 FROM economy_prices WHERE price_key = 'request_job_cost');

INSERT INTO economy_prices (price_key, price_cents, updated_at)
SELECT 'submit_job_cost', 40, strftime('%s','now')
WHERE NOT EXISTS (SELECT 1 FROM economy_prices WHERE price_key = 'submit_job_cost');

INSERT INTO economy_prices (price_key, price_cents, updated_at)
SELECT 'buy_tool_cost', 200, strftime('%s','now')
WHERE NOT EXISTS (SELECT 1 FROM economy_prices WHERE price_key = 'buy_tool_cost');

INSERT INTO economy_prices (price_key, price_cents, updated_at)
SELECT 'send_credits_cost', 15, strftime('%s','now')
WHERE NOT EXISTS (SELECT 1 FROM economy_prices WHERE price_key = 'send_credits_cost');

INSERT INTO economy_tools (tool_id, name, price_cents, created_at)
SELECT 'tool_basic', 'Basic Solver', 500, strftime('%s','now')
WHERE NOT EXISTS (SELECT 1 FROM economy_tools WHERE tool_id = 'tool_basic');

INSERT INTO economy_tools (tool_id, name, price_cents, created_at)
SELECT 'tool_pro', 'Pro Solver', 1200, strftime('%s','now')
WHERE NOT EXISTS (SELECT 1 FROM economy_tools WHERE tool_id = 'tool_pro');
