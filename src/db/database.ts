import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

export type DbClient = ReturnType<typeof drizzle>;

export function createDatabase(dbPath: string) {
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite);
  return { sqlite, db };
}
