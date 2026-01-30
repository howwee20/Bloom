import { createDatabase } from "../db/database.js";
import { getConfig } from "../config.js";
import { Kernel } from "../kernel/kernel.js";
import { SimpleEconomyWorld } from "../env/simple_economy.js";

function getArgValue(flag: string) {
  const idx = process.argv.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (idx === -1) return null;
  const arg = process.argv[idx];
  if (arg.includes("=")) return arg.split("=")[1] ?? null;
  return process.argv[idx + 1] ?? null;
}

async function main() {
  const agentId = getArgValue("--agent_id") ?? "agent_replay_seed";
  const config = { ...getConfig(), ENV_TYPE: "simple_economy" as const };
  const { db, sqlite } = createDatabase(config.DB_PATH);
  const env = new SimpleEconomyWorld(db, sqlite, config);
  const kernel = new Kernel(db, sqlite, env, config);

  const { user_id, agent_id } = kernel.createAgent({ agentId });
  const quote = await kernel.canDo({ user_id, agent_id, intent_json: { type: "request_job" } });
  await kernel.execute({ quote_id: quote.quote_id, idempotency_key: quote.idempotency_key });

  // eslint-disable-next-line no-console
  console.log(`Seeded replay with agent_id=${agent_id}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
