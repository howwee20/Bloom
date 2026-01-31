import { sqliteTable, text, integer, real, primaryKey, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  userId: text("user_id").primaryKey(),
  createdAt: integer("created_at").notNull()
});

export const agents = sqliteTable("agents", {
  agentId: text("agent_id").primaryKey(),
  userId: text("user_id").notNull(),
  status: text("status").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

export const agentTokens = sqliteTable("agent_tokens", {
  tokenId: text("token_id").primaryKey(),
  agentId: text("agent_id").notNull(),
  userId: text("user_id").notNull(),
  scopesJson: text("scopes_json", { mode: "json" }).notNull(),
  status: text("status").notNull(),
  createdAt: integer("created_at").notNull(),
  revokedAt: integer("revoked_at")
});

export const apiKeys = sqliteTable(
  "api_keys",
  {
    keyId: text("key_id").primaryKey(),
    userId: text("user_id").notNull(),
    keyHash: text("key_hash").notNull(),
    scopesJson: text("scopes_json", { mode: "json" }).notNull(),
    status: text("status").notNull(),
    createdAt: integer("created_at").notNull(),
    revokedAt: integer("revoked_at")
  },
  (table) => ({
    keyHashUnique: uniqueIndex("api_keys_key_hash_unique").on(table.keyHash)
  })
);

export const policies = sqliteTable("policies", {
  policyId: text("policy_id").primaryKey(),
  userId: text("user_id").notNull(),
  agentId: text("agent_id").notNull(),
  perIntentLimitJson: text("per_intent_limit_json", { mode: "json" }).notNull(),
  dailyLimitJson: text("daily_limit_json", { mode: "json" }).notNull(),
  allowlistJson: text("allowlist_json", { mode: "json" }).notNull(),
  blocklistJson: text("blocklist_json", { mode: "json" }).notNull(),
  stepUpThresholdJson: text("step_up_threshold_json", { mode: "json" }).notNull(),
  createdAt: integer("created_at").notNull()
});

export const budgets = sqliteTable("budgets", {
  agentId: text("agent_id").primaryKey(),
  creditsCents: integer("credits_cents").notNull(),
  dailySpendCents: integer("daily_spend_cents").notNull(),
  dailySpendUsedCents: integer("daily_spend_used_cents").notNull(),
  lastResetAt: integer("last_reset_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

export const quotes = sqliteTable(
  "quotes",
  {
    quoteId: text("quote_id").primaryKey(),
    userId: text("user_id").notNull(),
    agentId: text("agent_id").notNull(),
    intentJson: text("intent_json", { mode: "json" }).notNull(),
    allowed: integer("allowed").notNull(),
    requiresStepUp: integer("requires_step_up").notNull(),
    reason: text("reason").notNull(),
    expiresAt: integer("expires_at").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => ({
    agentIdemUnique: uniqueIndex("quotes_agent_idem_unique").on(table.agentId, table.idempotencyKey)
  })
);

export const executions = sqliteTable(
  "executions",
  {
    execId: text("exec_id").primaryKey(),
    quoteId: text("quote_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: text("agent_id").notNull(),
    status: text("status").notNull(),
    externalRef: text("external_ref"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => ({
    quoteUnique: uniqueIndex("executions_quote_unique").on(table.quoteId)
  })
);

export const events = sqliteTable("events", {
  eventId: text("event_id").primaryKey(),
  agentId: text("agent_id").notNull(),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  payloadJson: text("payload_json", { mode: "json" }).notNull(),
  occurredAt: integer("occurred_at").notNull(),
  createdAt: integer("created_at").notNull(),
  hash: text("hash").notNull(),
  prevHash: text("prev_hash")
});

export const receipts = sqliteTable("receipts", {
  receiptId: text("receipt_id").primaryKey(),
  agentId: text("agent_id").notNull(),
  userId: text("user_id").notNull(),
  source: text("source").notNull(),
  eventId: text("event_id"),
  externalRef: text("external_ref"),
  whatHappened: text("what_happened").notNull(),
  whyChanged: text("why_changed").notNull(),
  whatHappensNext: text("what_happens_next").notNull(),
  occurredAt: integer("occurred_at").notNull(),
  createdAt: integer("created_at").notNull()
});

export const stepUpChallenges = sqliteTable(
  "step_up_challenges",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    agentId: text("agent_id").notNull(),
    quoteId: text("quote_id").notNull(),
    status: text("status").notNull(),
    codeHash: text("code_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    approvedAt: integer("approved_at")
  }
);

export const stepUpTokens = sqliteTable(
  "step_up_tokens",
  {
    id: text("id").primaryKey(),
    challengeId: text("challenge_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull()
  }
);

export const cardHolds = sqliteTable(
  "card_holds",
  {
    agentId: text("agent_id").notNull(),
    authId: text("auth_id").primaryKey(),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => ({
    agentStatusIndex: index("card_holds_agent_status_idx").on(table.agentId, table.status)
  })
);

export const agentSpendSnapshot = sqliteTable("agent_spend_snapshot", {
  agentId: text("agent_id").primaryKey(),
  confirmedBalanceCents: integer("confirmed_balance_cents").notNull(),
  reservedOutgoingCents: integer("reserved_outgoing_cents").notNull(),
  reservedHoldsCents: integer("reserved_holds_cents").notNull(),
  policySpendableCents: integer("policy_spendable_cents").notNull(),
  effectiveSpendPowerCents: integer("effective_spend_power_cents").notNull(),
  updatedAt: integer("updated_at").notNull()
});

export const envHealth = sqliteTable("env_health", {
  envName: text("env_name").primaryKey(),
  status: text("status").notNull(),
  lastOkAt: integer("last_ok_at"),
  lastTickAt: integer("last_tick_at"),
  updatedAt: integer("updated_at").notNull()
});

export const economyPrices = sqliteTable("economy_prices", {
  priceKey: text("price_key").primaryKey(),
  priceCents: integer("price_cents").notNull(),
  updatedAt: integer("updated_at").notNull()
});

export const economyJobs = sqliteTable("economy_jobs", {
  jobId: integer("job_id").primaryKey({ autoIncrement: true }),
  prompt: text("prompt").notNull(),
  correctAnswer: text("correct_answer").notNull(),
  priceCents: integer("price_cents").notNull(),
  status: text("status").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

export const economyCompletedJobs = sqliteTable("economy_completed_jobs", {
  completedId: integer("completed_id").primaryKey({ autoIncrement: true }),
  jobId: integer("job_id").notNull(),
  agentId: text("agent_id").notNull(),
  answer: text("answer").notNull(),
  confidence: real("confidence").notNull(),
  correct: integer("correct").notNull(),
  rewardCents: integer("reward_cents").notNull(),
  completedAt: integer("completed_at").notNull()
});

export const economyTools = sqliteTable("economy_tools", {
  toolId: text("tool_id").primaryKey(),
  name: text("name").notNull(),
  priceCents: integer("price_cents").notNull(),
  createdAt: integer("created_at").notNull()
});

export const economyAgentTools = sqliteTable(
  "economy_agent_tools",
  {
    agentId: text("agent_id").notNull(),
    toolId: text("tool_id").notNull(),
    acquiredAt: integer("acquired_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.toolId] })
  })
);

export const economyAgentState = sqliteTable("economy_agent_state", {
  agentId: text("agent_id").primaryKey(),
  calibrationScore: real("calibration_score").notNull(),
  lastObservationAt: integer("last_observation_at").notNull()
});

export const economyActionDedup = sqliteTable("economy_action_dedup", {
  externalRef: text("external_ref").primaryKey(),
  agentId: text("agent_id").notNull(),
  intentJson: text("intent_json", { mode: "json" }).notNull(),
  resultJson: text("result_json", { mode: "json" }).notNull(),
  createdAt: integer("created_at").notNull()
});

export const baseUsdcWallets = sqliteTable(
  "base_usdc_wallets",
  {
    agentId: text("agent_id").primaryKey(),
    walletAddress: text("wallet_address").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => ({
    walletUnique: uniqueIndex("base_usdc_wallets_wallet_unique").on(table.walletAddress)
  })
);

export const baseUsdcBalanceCache = sqliteTable("base_usdc_balance_cache", {
  agentId: text("agent_id").primaryKey(),
  confirmedBalanceCents: integer("confirmed_balance_cents").notNull(),
  observedBlockNumber: integer("observed_block_number").notNull(),
  observedBlockTimestamp: integer("observed_block_timestamp").notNull(),
  updatedAt: integer("updated_at").notNull()
});

export const baseUsdcPendingTxs = sqliteTable(
  "base_usdc_pending_txs",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    quoteId: text("quote_id"),
    idempotencyKey: text("idempotency_key"),
    toAddress: text("to_address"),
    amountCents: integer("amount_cents").notNull(),
    txHash: text("tx_hash"),
    status: text("status").notNull(),
    submittedBlockNumber: integer("submitted_block_number"),
    confirmedBlockNumber: integer("confirmed_block_number"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => ({
    agentIdemUnique: uniqueIndex("base_usdc_pending_txs_agent_idem_unique").on(
      table.agentId,
      table.idempotencyKey
    ),
    txHashUnique: uniqueIndex("base_usdc_pending_txs_tx_hash_unique").on(table.txHash)
  })
);

export const baseUsdcActionDedup = sqliteTable(
  "base_usdc_action_dedup",
  {
    agentId: text("agent_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    quoteId: text("quote_id"),
    intentJson: text("intent_json", { mode: "json" }).notNull(),
    resultJson: text("result_json", { mode: "json" }).notNull(),
    txHash: text("tx_hash"),
    createdAt: integer("created_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.idempotencyKey] })
  })
);
