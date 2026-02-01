#!/usr/bin/env tsx
/**
 * Preflight Check Script
 *
 * Validates that the environment is correctly set up before running any commands.
 * Fails fast if Node version is wrong.
 */

import fs from "node:fs";

const nodeVersion = process.versions.node;
const major = parseInt(nodeVersion.split(".")[0], 10);

if (major !== 20 && major !== 22) {
  console.error("=== PREFLIGHT FAILED ===");
  console.error(`Node version: v${nodeVersion}`);
  console.error(`Expected: Node 20.x or 22.x`);
  console.error("");
  console.error("Fix:");
  console.error("  nvm use 20");
  console.error("  # or");
  console.error("  nvm use 22");
  console.error("");
  console.error("Then reinstall dependencies:");
  console.error("  rm -rf node_modules");
  console.error("  pnpm install");
  process.exit(1);
}

function isRunningInDocker() {
  if (process.env.BLOOM_DOCKER === "true" || process.env.DOCKER === "true") return true;
  if (fs.existsSync("/.dockerenv") || fs.existsSync("/.containerenv")) return true;
  try {
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    if (cgroup.includes("docker") || cgroup.includes("containerd") || cgroup.includes("kubepods")) return true;
  } catch {
    // ignore
  }
  return false;
}

const runningInDocker = isRunningInDocker();
const defaultDbPath = runningInDocker ? "/data/kernel.db" : "./data/kernel.db";
const dbPath = process.env.DB_PATH ?? defaultDbPath;
if (dbPath === "/data/kernel.db" && !runningInDocker) {
  console.error("=== PREFLIGHT FAILED ===");
  console.error("DB_PATH is set to /data/kernel.db, which is reserved for Docker.");
  console.error("Fix:");
  console.error("  export DB_PATH=./data/kernel.db");
  console.error("  # or set BLOOM_DOCKER=true when running inside Docker");
  process.exit(1);
}

console.log(`Preflight OK: Node v${nodeVersion}`);
console.log(`Preflight OK: DB_PATH=${dbPath}`);
