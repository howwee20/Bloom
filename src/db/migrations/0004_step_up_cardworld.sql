CREATE TABLE IF NOT EXISTS step_up_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired')),
  code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS step_up_challenges_pending_unique
  ON step_up_challenges(user_id, agent_id, quote_id)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS step_up_tokens (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(challenge_id) REFERENCES step_up_challenges(id)
);

CREATE INDEX IF NOT EXISTS step_up_tokens_challenge_idx
  ON step_up_tokens(challenge_id);

CREATE INDEX IF NOT EXISTS step_up_tokens_hash_idx
  ON step_up_tokens(token_hash);

CREATE TABLE IF NOT EXISTS card_holds (
  auth_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','settled','released','reversed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS card_holds_agent_status_idx
  ON card_holds(agent_id, status);

CREATE TABLE IF NOT EXISTS agent_spend_snapshot (
  agent_id TEXT PRIMARY KEY,
  confirmed_balance_cents INTEGER NOT NULL,
  reserved_outgoing_cents INTEGER NOT NULL,
  reserved_holds_cents INTEGER NOT NULL,
  policy_spendable_cents INTEGER NOT NULL,
  effective_spend_power_cents INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
