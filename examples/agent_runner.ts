import { BloomClient } from "../packages/sdk/src/index.js";

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function main() {
  const baseUrl = process.env.BLOOM_API_URL ?? "http://localhost:3000";
  const apiKey = process.env.BLOOM_API_KEY;
  if (!apiKey) {
    throw new Error("Missing BLOOM_API_KEY");
  }

  const client = new BloomClient({ baseUrl, apiKey });
  const agentId = process.env.BLOOM_AGENT_ID;
  const agent =
    agentId ? { agent_id: agentId } : await client.createAgent();

  // Read state and suggest a minimal action.
  const state = await client.getState(agent.agent_id);
  const observation = (state.observation ?? {}) as Record<string, unknown>;
  const spendPower = (state.spend_power ?? {}) as Record<string, unknown>;

  let intent: Record<string, unknown> | null = null;
  const confirmed = toNumber(observation.confirmed_balance_cents);
  const effective = toNumber(spendPower.effective_spend_power_cents);
  const toAddress = process.env.USDC_TO_ADDRESS;

  if (confirmed !== null && effective !== null && effective > 0 && toAddress) {
    const amount = Math.min(100, Math.floor(effective));
    intent = { type: "usdc_transfer", to_address: toAddress, amount_cents: amount };
  } else {
    intent = { type: "request_job" };
  }

  const quote = await client.canDo({ agent_id: agent.agent_id, intent_json: intent });
  if (!quote.allowed) {
    // eslint-disable-next-line no-console
    console.log("Action blocked:", quote.reason);
    return;
  }

  const exec = await client.execute({ quote_id: quote.quote_id, idempotency_key: quote.idempotency_key });
  // eslint-disable-next-line no-console
  console.log("Execution:", exec);

  const receipts = await client.getReceipts({ agent_id: agent.agent_id });
  const latest = receipts.receipts.slice(-5);
  // eslint-disable-next-line no-console
  console.log("Recent receipts:", latest);

  const updatedState = await client.getState(agent.agent_id);
  // eslint-disable-next-line no-console
  console.log("Spend power:", updatedState.spend_power ?? null);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
