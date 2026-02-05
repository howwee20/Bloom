import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

export function ensureMigrationsTable(sqlite: Database) {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"
  );
}

function getApplied(sqlite: Database) {
  const rows = sqlite.prepare("SELECT name FROM schema_migrations").all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function applyMigration(sqlite: Database, name: string, sql: string) {
  const now = Math.floor(Date.now() / 1000);
  const tx = sqlite.transaction(() => {
    sqlite.exec(sql);
    sqlite.prepare("INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, now);
  });
  tx();
}

export function applyMigrations(sqlite: Database, migrationsDir: string) {
  const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
  ensureMigrationsTable(sqlite);
  const applied = getApplied(sqlite);

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    applyMigration(sqlite, file, sql);
  }
}
