import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import type { Config } from "../config.js";

export type PolymarketApiCredentials = {
  apiKey: string;
  secret: string;
  passphrase: string;
};

export type PolymarketOrderResponse = Record<string, unknown>;
export type PolymarketOrderStatus = Record<string, unknown>;

export type PolymarketClobClient = {
  createAndPostOrder: (
    order: {
      tokenID: string;
      price: number;
      size: number;
      side: Side;
    },
    options?: Record<string, unknown>,
    orderType?: OrderType
  ) => Promise<PolymarketOrderResponse>;
  cancelOrder: (payload: { orderID: string }) => Promise<unknown>;
  getOrder: (orderId: string) => Promise<PolymarketOrderStatus>;
  getOpenOrders: () => Promise<PolymarketOrderStatus[]>;
};

let cachedCreds: PolymarketApiCredentials | null = null;

function normalizeCredentials(config: Config): PolymarketApiCredentials | null {
  const apiKey = config.POLY_API_KEY?.trim() ?? "";
  const secret = config.POLY_API_SECRET?.trim() ?? "";
  const passphrase = config.POLY_API_PASSPHRASE?.trim() ?? "";
  if (!apiKey && !secret && !passphrase) return null;
  if (!apiKey || !secret || !passphrase) {
    throw new Error("POLY_API_KEY_POLY_API_SECRET_POLY_API_PASSPHRASE_required");
  }
  return { apiKey, secret, passphrase };
}

function requirePrivateKey(config: Config) {
  const privateKey = config.POLY_PRIVATE_KEY?.trim() ?? "";
  if (!privateKey) throw new Error("POLY_PRIVATE_KEY_required");
  return privateKey;
}

export async function createClobClient(config: Config): Promise<PolymarketClobClient> {
  const privateKey = requirePrivateKey(config);
  const signer = new Wallet(privateKey);
  const host = config.POLY_CLOB_HOST;
  const chainId = config.POLY_CHAIN_ID;

  const credentials = normalizeCredentials(config) ?? cachedCreds;
  if (credentials) {
    return new ClobClient(host, chainId, signer, credentials) as PolymarketClobClient;
  }

  const l1Client = new ClobClient(host, chainId, signer) as unknown as {
    createOrDeriveApiKey: () => Promise<PolymarketApiCredentials>;
  };
  const derived = await l1Client.createOrDeriveApiKey();
  cachedCreds = derived;
  return new ClobClient(host, chainId, signer, derived) as PolymarketClobClient;
}

export function extractOrderId(response: PolymarketOrderResponse): string | null {
  const orderId = response.orderID ?? response.orderId ?? response.order_id;
  if (typeof orderId === "string" && orderId.trim().length > 0) return orderId;
  return null;
}

export function normalizeOrderStatus(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function parseNumeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export { OrderType, Side };
