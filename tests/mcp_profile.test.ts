import { describe, expect, it } from "vitest";
import { buildToolDefinitions } from "../src/mcp/server.js";

describe("mcp chatgpt profile", () => {
  it("only exposes safe tools", () => {
    const tools = buildToolDefinitions("chatgpt");
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "bloom_polymarket_bot_status",
        "bloom_polymarket_dryrun_bot_status",
        "bloom_polymarket_dryrun_cancel_order",
        "bloom_polymarket_dryrun_place_order",
        "bloom_ui_activity",
        "bloom_ui_state"
      ].sort()
    );
  });
});
