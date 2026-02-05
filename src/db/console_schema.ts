import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const consoleSessions = sqliteTable("console_sessions", {
  sessionId: text("session_id").primaryKey(),
  userId: text("user_id").notNull(),
  agentId: text("agent_id").notNull(),
  apiKey: text("api_key").notNull(),
  status: text("status").notNull(),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at").notNull()
});
