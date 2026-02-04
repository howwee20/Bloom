import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

export type DbClient = ReturnType<typeof drizzle>;

function ensureDbDir(dbPath: string) {
  if (!dbPath) return;
  if (dbPath === ":memory:" || dbPath === "file::memory:" || dbPath.includes("mode=memory")) {
    return;
  }
  if (dbPath.startsWith("file:")) {
    return;
  }
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function createDatabase(dbPath: string) {
  ensureDbDir(dbPath);
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite);
  return { sqlite, db };
}
