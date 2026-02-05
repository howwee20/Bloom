import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createDatabase } from "../src/db/database.js";
import { applyMigrations } from "../src/db/migrations.js";
import { getConfig } from "../src/config.js";

const HEALTH_URL = "http://localhost:3000/healthz";
const DEBUG_URL = "http://localhost:3000/console/debug";

function requireNode20() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major !== 20) {
    // eslint-disable-next-line no-console
    console.error(`Node 20 required. Current version: ${process.versions.node}`);
    process.exit(1);
  }
}

function ensureDirFor(dbPath: string) {
  if (dbPath === ":memory:" || dbPath === "file::memory:") return;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function waitForReady(url: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function main() {
  requireNode20();
  const config = getConfig();

  ensureDirFor(config.DB_PATH);
  ensureDirFor(config.CONSOLE_DB_PATH);

  const kernelDb = createDatabase(config.DB_PATH);
  applyMigrations(kernelDb.sqlite, path.resolve("src/db/migrations"));
  kernelDb.sqlite.close();

  const consoleDb = createDatabase(config.CONSOLE_DB_PATH);
  applyMigrations(consoleDb.sqlite, path.resolve("src/db/console_migrations"));
  consoleDb.sqlite.close();

  const server = spawn("pnpm", ["start"], { stdio: "inherit", env: process.env });

  let worker: ReturnType<typeof spawn> | null = null;
  if (config.ENV_TYPE === "base_usdc") {
    worker = spawn("pnpm", ["worker:base_usdc"], { stdio: "inherit", env: process.env });
  } else {
    // eslint-disable-next-line no-console
    console.log(`base_usdc reconcile skipped (ENV_TYPE=${config.ENV_TYPE})`);
  }

  const ready = await waitForReady(HEALTH_URL, 30_000);
  if (!ready) {
    // eslint-disable-next-line no-console
    console.error("Server did not become ready in time.");
  } else {
    // eslint-disable-next-line no-console
    console.log("✅ Console ready: http://localhost:3000/console");
    // eslint-disable-next-line no-console
    console.log(`✅ Using DB_PATH: ${config.DB_PATH}`);
    try {
      const res = await fetch(DEBUG_URL);
      if (res.ok) {
        const data = (await res.json()) as { wallet_address?: string | null };
        if (data?.wallet_address) {
          // eslint-disable-next-line no-console
          console.log(`✅ Wallet: ${data.wallet_address}`);
        }
      }
    } catch {
      // ignore
    }
  }

  const shutdown = () => {
    server.kill("SIGINT");
    if (worker) worker.kill("SIGINT");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.on("exit", (code) => {
    if (worker) worker.kill("SIGINT");
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
