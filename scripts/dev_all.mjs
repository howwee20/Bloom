import { spawn } from "node:child_process";
import process from "node:process";

const isWindows = process.platform === "win32";
const pnpmCmd = isWindows ? "pnpm.cmd" : "pnpm";

const children = new Set();
let shuttingDown = false;

function spawnProcess(label, args) {
  const child = spawn(pnpmCmd, args, { stdio: "inherit" });
  children.add(child);

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const proc of children) {
      if (proc.pid && proc !== child) {
        proc.kill("SIGINT");
      }
    }
    if (signal) {
      process.exit(1);
    }
    process.exit(code ?? 0);
  });

  child.on("error", () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const proc of children) {
      if (proc.pid && proc !== child) {
        proc.kill("SIGINT");
      }
    }
    process.exit(1);
  });

  return child;
}

process.on("SIGINT", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const proc of children) {
    if (proc.pid) {
      proc.kill("SIGINT");
    }
  }
});

spawnProcess("api", ["dev"]);
spawnProcess("web", ["-C", "web", "dev"]);
