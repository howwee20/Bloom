PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS base_usdc_wallets (
  agent_id TEXT PRIMARY KEY,
  wallet_address TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

CREATE TABLE IF NOT EXISTS base_usdc_balance_cache (
  agent_id TEXT PRIMARY KEY,
  confirmed_balance_cents INTEGER NOT NULL,
  observed_block_number INTEGER NOT NULL,
  observed_block_timestamp INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

CREATE TABLE IF NOT EXISTS base_usdc_pending_txs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  quote_id TEXT,
  idempotency_key TEXT,
  to_address TEXT,
  amount_cents INTEGER NOT NULL,
  tx_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','failed','dropped')),
  submitted_block_number INTEGER,
  confirmed_block_number INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS base_usdc_pending_txs_agent_idem_unique
  ON base_usdc_pending_txs(agent_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS base_usdc_pending_txs_tx_hash_unique
  ON base_usdc_pending_txs(tx_hash)
  WHERE tx_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS base_usdc_action_dedup (
  agent_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  quote_id TEXT,
  intent_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  tx_hash TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, idempotency_key),
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);
