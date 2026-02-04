import fs from "node:fs";
import path from "node:path";
import { createDatabase } from "./database.js";
import { getConfig } from "../config.js";

function ensureMigrationsTable(sqlite: import("better-sqlite3").Database) {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"
  );
}

function getApplied(sqlite: import("better-sqlite3").Database) {
  const rows = sqlite.prepare("SELECT name FROM schema_migrations").all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function applyMigration(sqlite: import("better-sqlite3").Database, name: string, sql: string) {
  const now = Math.floor(Date.now() / 1000);
  const tx = sqlite.transaction(() => {
    sqlite.exec(sql);
    sqlite.prepare("INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, now);
  });
  tx();
}

function applyMigrations(dbPath: string, files: string[]) {
  const { sqlite } = createDatabase(dbPath);
  ensureMigrationsTable(sqlite);
  const applied = getApplied(sqlite);

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(path.resolve("src/db/migrations"), file), "utf8");
    applyMigration(sqlite, file, sql);
  }

  sqlite.close();
}

function main() {
  const config = getConfig();
  const migrationsDir = path.resolve("src/db/migrations");
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  const consoleFiles = files.filter((file) => file.includes("console"));
  const kernelFiles = files.filter((file) => !consoleFiles.includes(file));

  if (config.CONSOLE_DB_PATH === config.DB_PATH) {
    applyMigrations(config.DB_PATH, files);
    return;
  }

  applyMigrations(config.DB_PATH, kernelFiles);
  if (consoleFiles.length > 0) {
    applyMigrations(config.CONSOLE_DB_PATH, consoleFiles);
  }
}

main();
