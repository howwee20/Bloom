#!/usr/bin/env tsx
import "dotenv/config";

const baseUrl = (process.env.BLOOM_BASE_URL ?? `http://localhost:${process.env.PORT ?? "3000"}`).replace(/\/+$/, "");
const adminKey = process.env.ADMIN_API_KEY ?? process.env.BLOOM_ADMIN_KEY ?? "";

if (!adminKey) {
  console.error("ADMIN_API_KEY is required to mint keys");
  process.exit(1);
}

type KeyResponse = {
  key_id: string;
  user_id: string;
  api_key: string;
  scopes: string[];
};

async function createKey(scopes: string[], userId?: string): Promise<KeyResponse> {
  const response = await fetch(`${baseUrl}/api/admin/keys`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-key": adminKey
    },
    body: JSON.stringify({ user_id: userId, scopes })
  });

  const text = await response.text();
  let data: KeyResponse | { error?: string } = {} as KeyResponse;
  if (text) {
    try {
      data = JSON.parse(text) as KeyResponse;
    } catch {
      data = { error: text };
    }
  }

  if (!response.ok) {
    const details = (data as { error?: string }).error ?? text ?? `HTTP ${response.status}`;
    throw new Error(`Failed to create key: ${details}`);
  }

  return data;
}

async function main() {
  const propose = await createKey(["propose"]);
  const read = await createKey(["read"], propose.user_id);

  console.log(`user_id=${propose.user_id}`);
  console.log(`BLOOM_PROPOSE_KEY=${propose.api_key}`);
  console.log(`BLOOM_READ_KEY=${read.api_key}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
