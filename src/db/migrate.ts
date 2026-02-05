import "dotenv/config";
import path from "node:path";
import { createDatabase } from "./database.js";
import { getConfig } from "../config.js";
import { applyMigrations } from "./migrations.js";

function main() {
  const config = getConfig();
  const { sqlite } = createDatabase(config.DB_PATH);
  const migrationsDir = path.resolve("src/db/migrations");
  applyMigrations(sqlite, migrationsDir);

  sqlite.close();
}

main();
