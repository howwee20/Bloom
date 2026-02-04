import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getConfig } from "../src/config.js";

function loadEnvFile(filePath = path.resolve(".env")) {
  if (!fs.existsSync(filePath)) return;
  const contents = fs.readFileSync(filePath, "utf8");
  contents.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return;
    let key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (key.startsWith("export ")) {
      key = key.slice(7).trim();
    }
    if (!key) return;
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\\n/g, "\n");
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

function ensureNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isNaN(major) || major < 20) {
    // eslint-disable-next-line no-console
    console.error("Node 20.x is required. Current:", process.versions.node);
    process.exit(1);
  }
}

function ensureDbDir(dbPath: string) {
  if (!dbPath) return;
  if (dbPath === ":memory:" || dbPath === "file::memory:" || dbPath.includes("mode=memory")) return;
  if (dbPath.startsWith("file:")) return;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function runCommand(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32"
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
    });
  });
}

function spawnProcess(command: string, args: string[]) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32"
  });
  return child;
}

async function waitForHealth(port: number) {
  const url = `http://localhost:${port}/healthz`;
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("API did not become healthy in time.");
}

async function main() {
  loadEnvFile();
  ensureNode();

  const config = getConfig();
  process.env.DB_PATH = config.DB_PATH;
  const port = Number(process.env.PORT ?? config.PORT ?? 3000);
  const envType = process.env.ENV_TYPE ?? config.ENV_TYPE ?? "simple_economy";

  ensureDbDir(config.DB_PATH);

  // eslint-disable-next-line no-console
  console.log("[bloom] Running migrations...");
  await runCommand("pnpm", ["migrate"]);

  // eslint-disable-next-line no-console
  console.log("[bloom] Starting API...");
  const api = spawnProcess("pnpm", ["start"]);

  let worker: ReturnType<typeof spawnProcess> | null = null;
  if (envType === "base_usdc") {
    // eslint-disable-next-line no-console
    console.log("[bloom] Starting Base USDC observer (reconcile)...");
    worker = spawnProcess("pnpm", ["worker:base_usdc"]);
  }

  await waitForHealth(port);
  // eslint-disable-next-line no-console
  console.log(`✅ Console ready: http://localhost:${port}/console`);
  // eslint-disable-next-line no-console
  console.log(`✅ Using DB_PATH: ${config.DB_PATH}`);

  try {
    const res = await fetch(`http://localhost:${port}/console/debug`);
    if (res.ok) {
      const debug = (await res.json()) as { wallet_address?: string | null };
      if (debug.wallet_address) {
        // eslint-disable-next-line no-console
        console.log(`✅ Wallet: ${debug.wallet_address}`);
      } else {
        // eslint-disable-next-line no-console
        console.log("Wallet: not available yet (import or create a Bloom in the Console).");
      }
    } else {
      // eslint-disable-next-line no-console
      console.log("Wallet: not available yet (debug endpoint not ready).");
    }
  } catch {
    // eslint-disable-next-line no-console
    console.log("Wallet: not available yet (debug endpoint not ready).");
  }
  // eslint-disable-next-line no-console
  console.log("✅ Connected. Test succeeded");

  const shutdown = () => {
    if (api) api.kill("SIGTERM");
    if (worker) worker.kill("SIGTERM");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
