import { createDatabase } from "../db/database.js";
import { getConfig } from "../config.js";
import { receipts } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { hashEvent } from "../kernel/utils.js";

function getArgValue(flag: string) {
  const idx = process.argv.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (idx === -1) return null;
  const arg = process.argv[idx];
  if (arg.includes("=")) return arg.split("=")[1] ?? null;
  return process.argv[idx + 1] ?? null;
}

function main() {
  const agentId = getArgValue("--agent_id");
  if (!agentId) {
    // eslint-disable-next-line no-console
    console.error("Missing --agent_id");
    process.exit(1);
  }

  const config = getConfig();
  const { db, sqlite } = createDatabase(config.DB_PATH);

  const eventRows = sqlite
    .prepare("SELECT * FROM events WHERE agent_id = ? ORDER BY rowid ASC")
    .all(agentId) as Array<{
    event_id: string;
    agent_id: string;
    user_id: string;
    type: string;
    payload_json: string;
    occurred_at: number;
    created_at: number;
    hash: string;
    prev_hash: string | null;
  }>;

  let prevHash: string | null = null;
  let ok = true;
  for (const ev of eventRows) {
    if ((ev.prev_hash ?? null) !== (prevHash ?? null)) {
      ok = false;
      // eslint-disable-next-line no-console
      console.error(`Prev hash mismatch at ${ev.event_id}`);
      break;
    }
    const computed = hashEvent({
      prevHash: ev.prev_hash ?? null,
      agentId: ev.agent_id,
      userId: ev.user_id,
      type: ev.type,
      occurredAt: ev.occurred_at,
      payload: JSON.parse(ev.payload_json) as Record<string, unknown>
    });
    if (computed !== ev.hash) {
      ok = false;
      // eslint-disable-next-line no-console
      console.error(`Hash mismatch at ${ev.event_id}`);
      break;
    }
    prevHash = ev.hash;
  }

  const receiptRows = db.select().from(receipts).where(eq(receipts.agentId, agentId)).all();
  const eventIds = new Set(eventRows.map((e) => e.event_id));
  for (const receipt of receiptRows) {
    if (receipt.eventId && !eventIds.has(receipt.eventId)) {
      ok = false;
      // eslint-disable-next-line no-console
      console.error(`Receipt ${receipt.receiptId} references missing event ${receipt.eventId}`);
      break;
    }
  }

  if (!ok) {
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(`Replay OK for agent ${agentId}. Events=${eventRows.length} Receipts=${receiptRows.length}`);
}

main();
