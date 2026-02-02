ALTER TABLE card_holds ADD COLUMN source TEXT NOT NULL DEFAULT 'card';

CREATE TABLE IF NOT EXISTS polymarket_orders (
  order_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  market_slug TEXT NOT NULL,
  token_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  price REAL NOT NULL,
  size REAL NOT NULL,
  cost_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','canceled','filled','expired')),
  client_order_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS polymarket_orders_agent_status_idx
  ON polymarket_orders(agent_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS polymarket_orders_agent_client_unique
  ON polymarket_orders(agent_id, client_order_id);
