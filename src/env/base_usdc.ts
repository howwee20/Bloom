import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { createPublicClient, createWalletClient, getAddress, http } from "viem";
import type { Account, Chain } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type { DbClient } from "../db/database.js";
import { baseUsdcBalanceCache, baseUsdcWallets, envHealth } from "../db/schema.js";
import type { Config } from "../config.js";
import { nowSeconds } from "../kernel/utils.js";
import type { EnvEvent, EnvFreshness, EnvFreshnessStatus, EnvObservation, EnvResult, IEnvironment } from "./IEnvironment.js";

const ENV_NAME = "base_usdc";

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }]
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [{ name: "success", type: "bool" }]
  }
] as const;

type RpcBlock = { number: bigint; timestamp: bigint };

type RpcClient = {
  getBlock: (args: { blockTag?: "latest"; blockNumber?: bigint }) => Promise<RpcBlock>;
  getBalance: (args: { address: `0x${string}` }) => Promise<bigint>;
  readContract: (args: {
    address: `0x${string}`;
    abi: typeof ERC20_ABI;
    functionName: "balanceOf";
    args: [`0x${string}`];
    blockNumber?: bigint;
  }) => Promise<bigint>;
};

type WalletClient = {
  writeContract: (args: {
    address: `0x${string}`;
    abi: typeof ERC20_ABI;
    functionName: "transfer";
    args: [`0x${string}`, bigint];
    account: Account;
  }) => Promise<`0x${string}`>;
};

type WalletClientFactory = (account: Account) => WalletClient;

function toFreshnessStatus(now: number, blockTimestamp: number, config: Config): EnvFreshnessStatus {
  const age = Math.max(0, now - blockTimestamp);
  if (age <= config.ENV_STALE_SECONDS) return "fresh";
  if (age <= config.ENV_UNKNOWN_SECONDS) return "stale";
  return "unknown";
}

function deriveAddressIndex(agentId: string) {
  const hash = createHash("sha256").update(agentId).digest();
  const raw = hash.readUInt32BE(0);
  const maxIndex = 2 ** 31 - 1;
  return raw % maxIndex;
}

function requireConfigValue(value: string | null, name: string) {
  if (!value) throw new Error(`${name}_required`);
  return value;
}

export class BaseUsdcWorld implements IEnvironment {
  envName = ENV_NAME;
  private db: DbClient;
  private sqlite: Database;
  private config: Config;
  private client: RpcClient;
  private usdcAddress: `0x${string}`;
  private chain: Chain;
  private rpcUrl: string;
  private walletClientFactory?: WalletClientFactory;

  constructor(
    db: DbClient,
    sqlite: Database,
    config: Config,
    options: { client?: RpcClient; walletClientFactory?: WalletClientFactory } = {}
  ) {
    this.db = db;
    this.sqlite = sqlite;
    this.config = config;
    this.walletClientFactory = options.walletClientFactory;
    this.chain = config.BASE_CHAIN === "base" ? base : baseSepolia;
    this.rpcUrl = requireConfigValue(config.BASE_RPC_URL, "BASE_RPC_URL");

    const contract = requireConfigValue(config.BASE_USDC_CONTRACT, "BASE_USDC_CONTRACT");
    requireConfigValue(config.DEV_MASTER_MNEMONIC, "DEV_MASTER_MNEMONIC");

    this.client =
      options.client ?? (createPublicClient({ chain: this.chain, transport: http(this.rpcUrl) }) as RpcClient);
    this.usdcAddress = getAddress(contract) as `0x${string}`;
  }

  private updateHealth(status: EnvFreshnessStatus, ok: boolean, now: number) {
    const current = this.db
      .select()
      .from(envHealth)
      .where(eq(envHealth.envName, this.envName))
      .get() as typeof envHealth.$inferSelect | undefined;
    const next = {
      envName: this.envName,
      status,
      lastOkAt: ok ? now : current?.lastOkAt ?? null,
      lastTickAt: now,
      updatedAt: now
    };
    if (!current) {
      this.db.insert(envHealth).values(next).run();
    } else {
      this.db.update(envHealth).set(next).where(eq(envHealth.envName, this.envName)).run();
    }
  }

  private ensureWallet(agentId: string) {
    const existing = this.db
      .select()
      .from(baseUsdcWallets)
      .where(eq(baseUsdcWallets.agentId, agentId))
      .get() as typeof baseUsdcWallets.$inferSelect | undefined;
    if (existing) return existing.walletAddress;

    const account = this.deriveAccount(agentId);
    const walletAddress = account.address;

    this.db
      .insert(baseUsdcWallets)
      .values({ agentId, walletAddress, createdAt: nowSeconds() })
      .run();
    return walletAddress;
  }

  private deriveAccount(agentId: string) {
    const mnemonic = requireConfigValue(this.config.DEV_MASTER_MNEMONIC, "DEV_MASTER_MNEMONIC");
    const addressIndex = deriveAddressIndex(agentId);
    return mnemonicToAccount(mnemonic, { addressIndex });
  }

  async getGasBalanceWei(agentId: string): Promise<bigint> {
    const walletAddress = this.ensureWallet(agentId);
    return this.client.getBalance({ address: walletAddress });
  }

  async sendUsdcTransfer(agentId: string, toAddress: `0x${string}`, amountCents: number) {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new Error("invalid_amount_cents");
    }
    const amountUnits = BigInt(amountCents) * 10_000n;
    const account = this.deriveAccount(agentId);
    const walletClient =
      this.walletClientFactory?.(account) ??
      (createWalletClient({ chain: this.chain, transport: http(this.rpcUrl), account }) as WalletClient);
    const txHash = await walletClient.writeContract({
      address: this.usdcAddress,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [toAddress, amountUnits],
      account
    });
    return { txHash, fromAddress: account.address };
  }

  async getFreshness(): Promise<EnvFreshness> {
    const now = nowSeconds();
    try {
      const latest = await this.client.getBlock({ blockTag: "latest" });
      const blockTimestamp = Number(latest.timestamp);
      const updatedAgo = Math.max(0, now - blockTimestamp);
      const status = toFreshnessStatus(now, blockTimestamp, this.config);
      this.updateHealth(status, status === "fresh", now);
      return {
        status,
        updated_ago_seconds: updatedAgo,
        details: `block_number=${latest.number.toString()} block_timestamp=${blockTimestamp}`
      };
    } catch (error) {
      const details = error instanceof Error ? error.message : "rpc_error";
      this.updateHealth("unknown", false, now);
      return {
        status: "unknown",
        updated_ago_seconds: this.config.ENV_UNKNOWN_SECONDS + 1,
        details: `error=${details}`
      };
    }
  }

  async getObservation(agentId: string): Promise<EnvObservation> {
    const now = nowSeconds();
    const walletAddress = this.ensureWallet(agentId);

    const latest = await this.client.getBlock({ blockTag: "latest" });
    const latestNumber = latest.number ?? 0n;
    const confirmations = Math.max(0, this.config.CONFIRMATIONS_REQUIRED);
    const confirmationsBig = BigInt(confirmations);
    const safeBlockNumber = latestNumber > confirmationsBig ? latestNumber - confirmationsBig : 0n;
    const safeBlock =
      safeBlockNumber === latestNumber ? latest : await this.client.getBlock({ blockNumber: safeBlockNumber });

    const balance = await this.client.readContract({
      address: this.usdcAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletAddress],
      blockNumber: safeBlockNumber
    });

    const balanceCentsBig = balance / 10_000n;
    if (balanceCentsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("confirmed_balance_overflow");
    }

    const confirmedBalanceCents = Number(balanceCentsBig);
    const observedBlockNumber = Number(safeBlock.number ?? safeBlockNumber);
    const observedBlockTimestamp = Number(safeBlock.timestamp ?? 0n);

    const existing = this.db
      .select()
      .from(baseUsdcBalanceCache)
      .where(eq(baseUsdcBalanceCache.agentId, agentId))
      .get() as typeof baseUsdcBalanceCache.$inferSelect | undefined;

    if (!existing) {
      this.db
        .insert(baseUsdcBalanceCache)
        .values({
          agentId,
          confirmedBalanceCents,
          observedBlockNumber,
          observedBlockTimestamp,
          updatedAt: now
        })
        .run();
    } else {
      this.db
        .update(baseUsdcBalanceCache)
        .set({
          confirmedBalanceCents,
          observedBlockNumber,
          observedBlockTimestamp,
          updatedAt: now
        })
        .where(eq(baseUsdcBalanceCache.agentId, agentId))
        .run();
    }

    const latestTimestamp = Number(latest.timestamp ?? 0n);
    const status = toFreshnessStatus(now, latestTimestamp, this.config);
    this.updateHealth(status, status === "fresh", now);

    return {
      env: this.envName,
      wallet_address: walletAddress,
      confirmed_balance_cents: confirmedBalanceCents,
      observed_block_number: observedBlockNumber,
      observed_block_timestamp: observedBlockTimestamp,
      confirmations_required: confirmations,
      buffer_cents: this.config.USDC_BUFFER_CENTS
    };
  }

  applyAction(agentId: string, intent: Record<string, unknown>): EnvResult {
    const event: EnvEvent = {
      type: "not_implemented",
      payload: { env: this.envName, agent_id: agentId, intent_type: String(intent.type ?? "") }
    };
    return { ok: false, envEvents: [event] };
  }
}
