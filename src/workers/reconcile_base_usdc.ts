import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { Chain } from "viem";
import { createDatabase } from "../db/database.js";
import { getConfig, type Config } from "../config.js";
import { agents, baseUsdcPendingTxs } from "../db/schema.js";
import type { DbClient } from "../db/database.js";
import Database from "better-sqlite3";
import { appendEvent } from "../kernel/events.js";
import { createReceipt } from "../kernel/receipts.js";
import { nowSeconds } from "../kernel/utils.js";
import { eq } from "drizzle-orm";
import { refreshAgentSpendSnapshot } from "../kernel/spend_snapshot.js";

type RpcReceipt = {
  blockNumber?: bigint | null;
  status?: "success" | "reverted" | "0x0" | "0x1" | 0 | 1 | boolean | null;
};

type RpcClient = {
  getBlockNumber: () => Promise<bigint>;
  getTransactionReceipt: (args: { hash: `0x${string}` }) => Promise<RpcReceipt | null | undefined>;
};

type ReconcileResult = {
  processed: number;
  confirmed: number;
  failed: number;
  skipped: number;
  pending: number;
};

function requireConfigValue(value: string | null, name: string) {
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function isReceiptSuccess(status: RpcReceipt["status"]) {
  return status === "success" || status === "0x1" || status === 1 || status === true;
}

function isReceiptReverted(status: RpcReceipt["status"]) {
  return status === "reverted" || status === "0x0" || status === 0 || status === false;
}

function getChain(config: Config): Chain {
  return config.BASE_CHAIN === "base" ? base : baseSepolia;
}

async function fetchReceipt(client: RpcClient, hash: `0x${string}`) {
  try {
    const receipt = await client.getTransactionReceipt({ hash });
    return receipt ?? null;
  } catch {
    return null;
  }
}

export async function reconcileBaseUsdcPendingTxs(input: {
  db: DbClient;
  sqlite: Database;
  config: Config;
  client?: RpcClient;
}): Promise<ReconcileResult> {
  if (input.config.ENV_TYPE !== "base_usdc") {
    return { processed: 0, confirmed: 0, failed: 0, skipped: 0, pending: 0 };
  }

  const pendingRows = input.db
    .select()
    .from(baseUsdcPendingTxs)
    .where(eq(baseUsdcPendingTxs.status, "pending"))
    .all();

  if (pendingRows.length === 0) {
    return { processed: 0, confirmed: 0, failed: 0, skipped: 0, pending: 0 };
  }

  const rpcUrl = requireConfigValue(input.config.BASE_RPC_URL, "BASE_RPC_URL");
  const client =
    input.client ??
    (createPublicClient({ chain: getChain(input.config), transport: http(rpcUrl) }) as RpcClient);

  const latestBlock = await client.getBlockNumber();
  const confirmationsRequired = Math.max(0, input.config.CONFIRMATIONS_REQUIRED);

  let confirmed = 0;
  let failed = 0;
  let skipped = 0;
  let stillPending = 0;

  for (const row of pendingRows) {
    if (!row.txHash) {
      skipped += 1;
      continue;
    }

    const receipt = await fetchReceipt(client, row.txHash as `0x${string}`);
    if (!receipt || receipt.blockNumber == null) {
      stillPending += 1;
      continue;
    }

    const blockNumber = receipt.blockNumber;
    const confirmations =
      latestBlock >= blockNumber ? Number(latestBlock - blockNumber + 1n) : 0;
    if (confirmations < confirmationsRequired) {
      stillPending += 1;
      continue;
    }

    const status = receipt.status;
    const isSuccess = isReceiptSuccess(status);
    const isReverted = isReceiptReverted(status);
    if (!isSuccess && !isReverted) {
      stillPending += 1;
      continue;
    }

    const agentRow = input.db.select().from(agents).where(eq(agents.agentId, row.agentId)).get();
    if (!agentRow) {
      skipped += 1;
      continue;
    }

    const now = nowSeconds();
    const confirmedBlockNumber = Number(blockNumber);
    const outcome = isSuccess ? "confirmed" : "failed";
    const eventType = isSuccess ? "usdc_transfer_confirmed" : "usdc_transfer_reverted";

    const finalizeTx = input.sqlite.transaction(() => {
      input.db
        .update(baseUsdcPendingTxs)
        .set({
          status: outcome,
          confirmedBlockNumber,
          updatedAt: now
        })
        .where(eq(baseUsdcPendingTxs.id, row.id))
        .run();

      refreshAgentSpendSnapshot({
        db: input.db,
        sqlite: input.sqlite,
        config: input.config,
        agentId: row.agentId
      });

      const event = appendEvent(input.db, input.sqlite, {
        agentId: row.agentId,
        userId: agentRow.userId,
        type: eventType,
        payload: {
          system: true,
          tx_hash: row.txHash,
          quote_id: row.quoteId ?? null,
          idempotency_key: row.idempotencyKey ?? null,
          to_address: row.toAddress ?? null,
          amount_cents: row.amountCents,
          status: outcome,
          confirmations,
          required_confirmations: confirmationsRequired,
          confirmed_block_number: confirmedBlockNumber,
          budget_refund: "none"
        }
      });

      const whatHappened = isSuccess
        ? `USDC transfer confirmed on-chain. tx_hash=${row.txHash} confirmed_block_number=${confirmedBlockNumber} confirmations=${confirmations}`
        : `USDC transfer reverted on-chain. tx_hash=${row.txHash} confirmed_block_number=${confirmedBlockNumber} confirmations=${confirmations}`;
      createReceipt(input.db, {
        agentId: row.agentId,
        userId: agentRow.userId,
        source: "env",
        eventId: event.event_id,
        externalRef: row.txHash,
        whatHappened,
        whyChanged: isSuccess ? "reconcile_confirmed" : "reconcile_reverted",
        whatHappensNext: "Budget is not refunded automatically."
      });
    });

    finalizeTx();

    if (isSuccess) {
      confirmed += 1;
    } else {
      failed += 1;
    }
  }

  return {
    processed: pendingRows.length,
    confirmed,
    failed,
    skipped,
    pending: stillPending
  };
}

async function main() {
  const config = getConfig();
  const dir = path.dirname(config.DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const { db, sqlite } = createDatabase(config.DB_PATH);
  const result = await reconcileBaseUsdcPendingTxs({ db, sqlite, config });
  // eslint-disable-next-line no-console
  console.log(
    `base_usdc reconcile: processed=${result.processed} confirmed=${result.confirmed} failed=${result.failed} pending=${result.pending} skipped=${result.skipped}`
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
