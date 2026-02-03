type ReceiptRow = {
  receiptId: string;
  agentId: string;
  userId: string;
  source: string;
  eventId: string | null;
  externalRef: string | null;
  groupKey?: string | null;
  quoteId?: string | null;
  whatHappened: string;
  whyChanged: string;
  whatHappensNext: string;
  occurredAt: number;
  createdAt: number;
};

type StepKind =
  | "approved"
  | "needs_approval"
  | "held"
  | "released"
  | "canceled"
  | "sent"
  | "pending"
  | "confirmed"
  | "declined"
  | "tick";

type StepDetails = {
  amountCents?: number;
  toAddress?: string;
  txHash?: string;
  blockNumber?: number;
  reason?: string;
};

export type HumanStep = {
  kind: StepKind;
  label: string;
  timestamp: number;
  details?: StepDetails;
};

export type TransactionRollup = {
  id: string;
  quote_id?: string;
  status: "pending" | "confirmed" | "declined";
  headline: string;
  steps: HumanStep[];
  tx_hash?: string;
  block?: number;
  time: number;
  details?: {
    amount_cents?: number;
    to_address?: string;
    reason?: string;
    tx_hash?: string;
    block?: number;
  };
};

export type UiActivityItem = {
  id: string;
  line: string;
  status: "pending" | "confirmed" | "declined";
  when: string;
  summary: string[];
  details: {
    tx_hash?: string;
    to?: string;
    amount?: string;
  };
};

const TX_HASH_REGEX = /tx_hash=([0-9a-fA-Fx]+)/;
const AMOUNT_REGEX = /amount_cents=(\d+)/;
const TO_ADDRESS_REGEX = /to_address=([0-9a-fA-Fx]+)/;
const REASON_REGEX = /reason=([^\s]+)/;
const BLOCK_REGEX = /confirmed_block_number=(\d+)/;

const STEP_ORDER: Record<StepKind, number> = {
  tick: 0,
  approved: 1,
  needs_approval: 2,
  held: 3,
  released: 4,
  canceled: 5,
  sent: 6,
  pending: 7,
  confirmed: 8,
  declined: 9
};

const REASON_MAP: Record<string, string> = {
  intent_not_allowlisted: "Not on your allowlist",
  insufficient_gas: "Not enough for network fee",
  insufficient_spend_power: "Not enough funds",
  policy_limit_exceeded: "Exceeds your daily limit",
  stale_environment: "Couldn't verify — try again",
  frozen: "Account frozen"
};

function titleCase(value: string) {
  return value
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseMatch(regex: RegExp, value: string) {
  const match = value.match(regex);
  return match?.[1];
}

function parseNumber(value: string | undefined) {
  if (!value) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function extractTxHash(text: string) {
  return parseMatch(TX_HASH_REGEX, text);
}

function extractAmountCents(text: string) {
  return parseNumber(parseMatch(AMOUNT_REGEX, text));
}

function extractToAddress(text: string) {
  return parseMatch(TO_ADDRESS_REGEX, text);
}

function extractReason(text: string) {
  return parseMatch(REASON_REGEX, text);
}

function extractBlockNumber(text: string) {
  return parseNumber(parseMatch(BLOCK_REGEX, text));
}

function formatClock(date: Date) {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function formatWhen(timestampSeconds: number, nowSeconds: number) {
  const date = new Date(timestampSeconds * 1000);
  const now = new Date(nowSeconds * 1000);
  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isSameDay) return `Today ${formatClock(date)}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();
  if (isYesterday) return `Yesterday ${formatClock(date)}`;

  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${day} ${formatClock(date)}`;
}

export function formatUpdated(updatedAtSeconds: number | null | undefined, nowSeconds: number) {
  if (!updatedAtSeconds || !Number.isFinite(updatedAtSeconds)) {
    return new Date(nowSeconds * 1000).toISOString();
  }
  if (Math.abs(nowSeconds - updatedAtSeconds) <= 60) return "just now";
  return new Date(updatedAtSeconds * 1000).toISOString();
}

export function formatMoney(cents: number) {
  if (!Number.isFinite(cents)) return "$0.00";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

export function shortenAddress(address: string, prefix = 6, suffix = 4) {
  const trimmed = String(address ?? "").trim();
  if (!trimmed) return trimmed;
  if (trimmed.length <= prefix + suffix + 1) return trimmed;
  return `${trimmed.slice(0, prefix)}…${trimmed.slice(-suffix)}`;
}

export function mapReasonToHuman(reason: string | null | undefined) {
  if (!reason) return null;
  const cleaned = String(reason).trim();
  if (!cleaned) return null;
  const mapped = REASON_MAP[cleaned];
  if (mapped) return mapped;
  return titleCase(cleaned.replace(/_/g, " "));
}

export function mapReceiptToHumanStep(receipt: ReceiptRow): HumanStep | null {
  const what = receipt.whatHappened ?? "";
  const why = receipt.whyChanged ?? "";
  const timestamp = receipt.occurredAt ?? receipt.createdAt;
  const base = { timestamp };

  if (what.startsWith("Step-up token accepted.")) return null;

  if (what.startsWith("Policy approved intent.") || what.startsWith("Policy re-check approved.")) {
    return { kind: "approved", label: "Approved", ...base };
  }

  if (what.startsWith("Policy rejected intent.")) {
    return {
      kind: "declined",
      label: "Declined",
      ...base,
      details: { reason: mapReasonToHuman(why) ?? why }
    };
  }

  if (what.startsWith("Execution rejected") || what.startsWith("Execution failed.") || what.startsWith("Environment rejected action.")) {
    return {
      kind: "declined",
      label: "Declined",
      ...base,
      details: { reason: mapReasonToHuman(why) ?? why }
    };
  }

  if (what.startsWith("Step-up challenge created.")) {
    return { kind: "needs_approval", label: "Needs approval", ...base };
  }

  if (what.startsWith("Budget reserved for execution.")) {
    return { kind: "held", label: "Held", ...base };
  }

  if (what.startsWith("Hold created.")) {
    const amountCents = extractAmountCents(what);
    return amountCents !== undefined
      ? { kind: "held", label: "Held", ...base, details: { amountCents } }
      : { kind: "held", label: "Held", ...base };
  }

  if (what.startsWith("Hold released.")) {
    const amountCents = extractAmountCents(what);
    return amountCents !== undefined
      ? { kind: "released", label: "Released", ...base, details: { amountCents } }
      : { kind: "released", label: "Released", ...base };
  }

  if (what.startsWith("Order canceled.") || what.startsWith("Dry-run order canceled.")) {
    return { kind: "canceled", label: "Canceled", ...base };
  }

  if (what.startsWith("Order filled.")) {
    return { kind: "confirmed", label: "Filled", ...base };
  }

  if (what.startsWith("USDC transfer broadcast.")) {
    return {
      kind: "sent",
      label: "Sent",
      ...base,
      details: {
        txHash: extractTxHash(what),
        amountCents: extractAmountCents(what),
        toAddress: extractToAddress(what)
      }
    };
  }

  if (what.startsWith("USDC transfer failed.")) {
    const reason = mapReasonToHuman(extractReason(what) ?? why) ?? extractReason(what) ?? why;
    return {
      kind: "declined",
      label: "Declined",
      ...base,
      details: {
        txHash: extractTxHash(what),
        amountCents: extractAmountCents(what),
        toAddress: extractToAddress(what),
        reason
      }
    };
  }

  if (what.startsWith("USDC transfer confirmed on-chain.")) {
    return {
      kind: "confirmed",
      label: "Confirmed",
      ...base,
      details: {
        txHash: extractTxHash(what),
        blockNumber: extractBlockNumber(what)
      }
    };
  }

  if (what.startsWith("USDC transfer reverted on-chain.")) {
    return {
      kind: "declined",
      label: "Declined",
      ...base,
      details: {
        txHash: extractTxHash(what),
        blockNumber: extractBlockNumber(what),
        reason: "Transaction reverted"
      }
    };
  }

  if (what.startsWith("Execution applied.")) {
    return { kind: "pending", label: "Pending", ...base };
  }

  if (what.startsWith("Polymarket bot tick")) {
    return { kind: "tick", label: "Bot tick", ...base };
  }

  return null;
}

function groupReceipts(receipts: ReceiptRow[]) {
  const groups = new Map<string, ReceiptRow[]>();
  for (const receipt of receipts) {
    const key = receipt.groupKey ?? receipt.receiptId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(receipt);
  }
  return groups;
}

function buildHeadline(
  status: "pending" | "confirmed" | "declined",
  steps: HumanStep[],
  amountCents?: number,
  toAddress?: string,
  reason?: string
) {
  if (status === "declined") {
    return reason ? `Declined · ${reason}` : "Declined";
  }

  const hasSent = steps.some((step) => step.kind === "sent");
  const hasHeld = steps.some((step) => step.kind === "held");
  const hasReleased = steps.some((step) => step.kind === "released");
  const hasCanceled = steps.some((step) => step.kind === "canceled");
  const hasTick = steps.some((step) => step.kind === "tick");
  const hasApproved = steps.some((step) => step.kind === "approved");
  const hasNeedsApproval = steps.some((step) => step.kind === "needs_approval");
  if (hasTick) {
    return "Polymarket bot tick · Observe-only";
  }

  const verb = hasCanceled
    ? "Canceled"
    : hasSent
      ? "Sent"
      : hasHeld
        ? "Held"
        : hasApproved
          ? "Approved"
          : hasNeedsApproval
            ? "Needs approval"
            : "Pending";
  const statusLabel = hasReleased ? "Released" : status === "confirmed" ? "Confirmed" : "Pending";

  if (amountCents !== undefined && toAddress) {
    return `${verb} ${formatMoney(amountCents)} · ${shortenAddress(toAddress)} · ${statusLabel}`;
  }
  if (amountCents !== undefined) {
    return `${verb} ${formatMoney(amountCents)} · ${statusLabel}`;
  }
  return `${verb} · ${statusLabel}`;
}

function formatSummaryStep(step: HumanStep, amountCents: number | undefined, nowSeconds: number, blockNumber?: number) {
  const timeLabel = formatClock(new Date(step.timestamp * 1000));
  let label = step.label;
  if ((step.kind === "held" || step.kind === "sent") && amountCents !== undefined) {
    label = `${label} ${formatMoney(amountCents)}`;
  }
  if (step.kind === "released" && amountCents !== undefined) {
    label = `${label} ${formatMoney(amountCents)}`;
  }
  if (step.kind === "declined" && step.details?.reason) {
    label = `${label} · ${step.details.reason}`;
  }
  if (step.kind === "confirmed" && blockNumber !== undefined) {
    label = `${label} · Block ${blockNumber.toLocaleString("en-US")}`;
  }
  return `${label} · ${timeLabel}`;
}

export function rollupTransactionByExternalRef(
  externalRef: string,
  receipts: ReceiptRow[],
  options: { nowSeconds?: number } = {}
): TransactionRollup | null {
  if (!receipts.length) return null;
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const quoteId = receipts.reduce<string | undefined>((acc, receipt) => {
    if (acc) return acc;
    const id = receipt.quoteId ?? undefined;
    return id ?? acc;
  }, undefined);
  const hasStepUpToken = receipts.some((receipt) => receipt.whatHappened?.startsWith("Step-up token accepted."));

  let steps = receipts
    .filter((receipt) => !(hasStepUpToken && receipt.whatHappened?.startsWith("Step-up challenge created.")))
    .map(mapReceiptToHumanStep)
    .filter((step): step is HumanStep => Boolean(step));

  if (!steps.length) return null;

  steps.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return STEP_ORDER[a.kind] - STEP_ORDER[b.kind];
  });

  const hasConfirmed = steps.some((step) => step.kind === "confirmed");
  if (hasConfirmed) {
    steps = steps.filter((step) => step.kind !== "pending");
  }

  const deduped: HumanStep[] = [];
  const seen = new Set<StepKind>();
  for (const step of steps) {
    if (seen.has(step.kind)) continue;
    seen.add(step.kind);
    deduped.push(step);
  }

  const details: StepDetails = {};
  for (const step of deduped) {
    if (step.details?.amountCents !== undefined && details.amountCents === undefined) {
      details.amountCents = step.details.amountCents;
    }
    if (step.details?.toAddress && !details.toAddress) {
      details.toAddress = step.details.toAddress;
    }
    if (step.details?.txHash && !details.txHash) {
      details.txHash = step.details.txHash;
    }
    if (step.details?.blockNumber !== undefined && details.blockNumber === undefined) {
      details.blockNumber = step.details.blockNumber;
    }
    if (step.details?.reason && !details.reason) {
      details.reason = step.details.reason;
    }
  }

  const status = deduped.some((step) => step.kind === "declined")
    ? "declined"
    : deduped.some((step) => step.kind === "confirmed" || step.kind === "released" || step.kind === "canceled")
      ? "confirmed"
      : "pending";

  const time = receipts.reduce((max, receipt) => Math.max(max, receipt.occurredAt ?? receipt.createdAt), 0);
  const headline = buildHeadline(status, deduped, details.amountCents, details.toAddress, details.reason);

  return {
    id: externalRef,
    quote_id: quoteId,
    status,
    headline,
    steps: deduped,
    tx_hash: details.txHash,
    block: details.blockNumber,
    time,
    details: {
      amount_cents: details.amountCents,
      to_address: details.toAddress,
      reason: details.reason,
      tx_hash: details.txHash,
      block: details.blockNumber
    }
  };
}

export function buildUiActivity(receipts: ReceiptRow[], options: { limit?: number; nowSeconds?: number } = {}) {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const groups = groupReceipts(receipts);
  const rollups: TransactionRollup[] = [];
  for (const [key, group] of groups.entries()) {
    const rollup = rollupTransactionByExternalRef(key, group, { nowSeconds });
    if (rollup) rollups.push(rollup);
  }

  const isApprovalOnly = (rollup: TransactionRollup) => {
    if (rollup.status !== "pending") return false;
    if (rollup.details?.amount_cents !== undefined) return false;
    if (rollup.details?.to_address) return false;
    if (rollup.details?.tx_hash) return false;
    const kinds = new Set(rollup.steps.map((step) => step.kind));
    if (kinds.size === 0) return false;
    for (const kind of kinds) {
      if (kind !== "approved" && kind !== "pending") return false;
    }
    return true;
  };

  const nonApprovalQuoteIds = new Set(
    rollups
      .filter((rollup) => !isApprovalOnly(rollup))
      .map((rollup) => rollup.quote_id)
      .filter((value): value is string => Boolean(value))
  );

  const filtered = rollups.filter((rollup) => {
    if (!isApprovalOnly(rollup)) return true;
    if (rollup.quote_id && nonApprovalQuoteIds.has(rollup.quote_id)) return false;
    return true;
  });

  filtered.sort((a, b) => {
    if (a.time !== b.time) return b.time - a.time;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
  const limit = options.limit ? Math.max(1, Math.floor(options.limit)) : filtered.length;
  const trimmed = filtered.slice(0, limit);

  return trimmed.map((rollup) => {
    const amountCents = rollup.details?.amount_cents;
    const toAddress = rollup.details?.to_address;
    const txHash = rollup.details?.tx_hash;
    const blockNumber = rollup.details?.block;

    return {
      id: rollup.id,
      line: rollup.headline,
      status: rollup.status,
      when: formatWhen(rollup.time, nowSeconds),
      summary: rollup.steps.map((step) => formatSummaryStep(step, amountCents, nowSeconds, blockNumber)),
      details: {
        tx_hash: txHash ? shortenAddress(txHash) : undefined,
        to: toAddress ? shortenAddress(toAddress) : undefined,
        amount: amountCents !== undefined ? formatMoney(amountCents) : undefined
      }
    };
  });
}
