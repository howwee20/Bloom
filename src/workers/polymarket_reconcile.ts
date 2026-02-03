import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createDatabase } from "../db/database.js";
import { getConfig } from "../config.js";
import { reconcilePolymarketOrders } from "../polymarket/reconcile.js";

async function main() {
  const config = getConfig();
  const dir = path.dirname(config.DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const { db, sqlite } = createDatabase(config.DB_PATH);
  const result = await reconcilePolymarketOrders({ db, sqlite, config });
  // eslint-disable-next-line no-console
  console.log(
    `polymarket reconcile: processed=${result.processed} filled=${result.filled} canceled=${result.canceled} expired=${result.expired} pending=${result.pending} skipped=${result.skipped}`
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
