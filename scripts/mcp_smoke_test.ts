import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const agentId = process.env.BLOOM_AGENT_ID ?? "";
if (!agentId) {
  // eslint-disable-next-line no-console
  console.error("BLOOM_AGENT_ID required");
  process.exit(1);
}

async function main() {
  const transport = new StdioClientTransport({
    command: "tsx",
    args: ["src/mcp/server.ts"],
    env: process.env
  });

  const client = new Client({ name: "bloom-mcp-smoke", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  const response = await client.callTool({
    name: "bloom_get_state",
    arguments: { agent_id: agentId }
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(response, null, 2));
  await client.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
