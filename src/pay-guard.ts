/**
 * Pay Guard pieces used by the daily buy:
 * - an idempotency store, so a retry after a crash or a dropped connection never signs a second payment
 * - a bundle receipt (pay-guard.bundle.v1) that a third party can check with vet402's public API and the chain
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createPublicClient, http, parseAbi, recoverMessageAddress, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

import { CELO_MAINNET_RPC, VET402_API_BASE } from "./chain.js";

// ---------- idempotency ----------

export type IntentStatus = "signed" | "settled" | "expired";

export type IntentRecord = {
  intentKey: string;
  payer: `0x${string}`;
  payTo: `0x${string}`;
  asset: `0x${string}`;
  units: string;
  nonce: Hex;
  validBefore: string;
  status: IntentStatus;
  txHash?: `0x${string}`;
  /** true once the payment has a row in MAINNET_RUN.md, so the spend cap counts it exactly once. */
  logged?: boolean;
  signedAt: string;
  settledAt?: string;
};

export interface IntentStore {
  get(intentKey: string): IntentRecord | undefined;
  put(record: IntentRecord): void;
  list(): IntentRecord[];
}

/**
 * One daily buy per payer per UTC day, so the key is (day, payer). Seller, price or payTo changing
 * between a crash and the retry must not produce a fresh key (that would allow a second payment).
 */
export function computeIntentKey(parts: { day: string; payer: string }): string {
  return createHash("sha256").update(`daily-buy|${parts.day}|${parts.payer.toLowerCase()}`).digest("hex");
}

export class FileIntentStore implements IntentStore {
  constructor(private readonly dir: string) {}

  private path(intentKey: string): string {
    if (!/^[0-9a-f]{64}$/.test(intentKey)) throw new Error("invalid intent key");
    return join(this.dir, `${intentKey}.json`);
  }

  get(intentKey: string): IntentRecord | undefined {
    try {
      return JSON.parse(readFileSync(this.path(intentKey), "utf8")) as IntentRecord;
    } catch (err) {
      // Only "no such file" means no record. Anything else (permissions, broken JSON) must stop the payment.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  put(record: IntentRecord): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(record.intentKey), `${JSON.stringify(record, null, 2)}\n`);
  }

  list(): IntentRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return names
      .filter((n) => /^[0-9a-f]{64}\.json$/.test(n))
      .map((n) => JSON.parse(readFileSync(join(this.dir, n), "utf8")) as IntentRecord);
  }

  /**
   * Exclusive lock so two runs cannot both see "no record" and both sign.
   * A lock left by a dead process (or older than LOCK_STALE_MS) is taken over: the pay decision is made
   * inside the lock from the chain, so taking over an orphaned lock cannot cause a second payment.
   */
  lock(): () => void {
    mkdirSync(this.dir, { recursive: true });
    const p = join(this.dir, ".lock");
    const take = () => {
      const fd = openSync(p, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
    };
    try {
      take();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holder: { pid?: number; at?: string } = {};
      try {
        holder = JSON.parse(readFileSync(p, "utf8"));
      } catch {
        // unreadable lock: judge by age only
      }
      const age = holder.at ? Date.now() - Date.parse(holder.at) : Number.POSITIVE_INFINITY;
      if (pidAlive(holder.pid) && age < LOCK_STALE_MS) {
        throw new Error(`daily buy lock held by pid ${holder.pid} since ${holder.at} (${p})`);
      }
      unlinkSync(p);
      take();
    }
    return () => {
      try {
        unlinkSync(p);
      } catch {
        // already gone
      }
    };
  }
}

export class MemoryIntentStore implements IntentStore {
  readonly records = new Map<string, IntentRecord>();
  get(intentKey: string): IntentRecord | undefined {
    return this.records.get(intentKey);
  }
  put(record: IntentRecord): void {
    this.records.set(record.intentKey, { ...record });
  }
  list(): IntentRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }
}

export const LOCK_STALE_MS = 30 * 60 * 1000;

function pidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Seconds of slack on validBefore: local clock ahead of the chain, or an RPC node a few blocks behind. */
export const EXPIRY_MARGIN_SEC = 300;

/** Reads EIP-3009 authorizationState(authorizer, nonce) on the token. true = the authorization was used. */
export type AuthorizationStateReader = (params: {
  asset: `0x${string}`;
  authorizer: `0x${string}`;
  nonce: Hex;
}) => Promise<boolean>;

const EIP3009_ABI = parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]);

export function createAuthorizationStateReader(rpcUrl: string): AuthorizationStateReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 8_000 }) });
  return async ({ asset, authorizer, nonce }) =>
    client.readContract({ address: asset, abi: EIP3009_ABI, functionName: "authorizationState", args: [authorizer, nonce] });
}

export type RetryDecision =
  | { action: "sign"; reason: "no_prior_intent" | "prior_authorization_expired_unused" }
  | { action: "stop"; reason: "already_paid"; record: IntentRecord }
  | {
      action: "stop";
      reason: "prior_authorization_still_valid" | "authorization_state_unknown" | "other_intent_unresolved";
      record: IntentRecord;
    };

/**
 * Decides whether a new payment may be signed for this intent.
 * A prior signed authorization that the chain reports as used is never signed again.
 * If the chain cannot be read, stop (never pay on unknown).
 */
export async function decideBeforeSigning(params: {
  store: IntentStore;
  intentKey: string;
  readAuthorizationState: AuthorizationStateReader;
  nowSec?: number;
}): Promise<RetryDecision> {
  // Any other signed-but-unsettled authorization (older day, other key) blocks a new signature until it resolves.
  for (const other of params.store.list()) {
    if (other.intentKey === params.intentKey || other.status !== "signed") continue;
    const d = await decideOne(other, params.readAuthorizationState, params.nowSec);
    if (d.action === "sign") {
      params.store.put({ ...other, status: "expired" });
      continue;
    }
    if (d.reason === "already_paid") {
      // An older payment did go through: settle its record (it stays unlogged, so the cap still counts it).
      params.store.put({ ...other, status: "settled", settledAt: other.settledAt ?? new Date().toISOString() });
      continue;
    }
    return { ...d, reason: "other_intent_unresolved" };
  }
  const record = params.store.get(params.intentKey);
  if (!record) return { action: "sign", reason: "no_prior_intent" };
  return decideOne(record, params.readAuthorizationState, params.nowSec);
}

async function decideOne(
  record: IntentRecord,
  readAuthorizationState: AuthorizationStateReader,
  nowSec?: number,
): Promise<RetryDecision> {
  if (record.status === "settled") return { action: "stop", reason: "already_paid", record };
  let used: boolean;
  try {
    used = await readAuthorizationState({ asset: record.asset, authorizer: record.payer, nonce: record.nonce });
  } catch {
    return { action: "stop", reason: "authorization_state_unknown", record };
  }
  if (used) return { action: "stop", reason: "already_paid", record };
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  if (BigInt(record.validBefore) + BigInt(EXPIRY_MARGIN_SEC) > BigInt(now)) {
    // The seller or facilitator may still settle it. Waiting is safe; signing again is not.
    return { action: "stop", reason: "prior_authorization_still_valid", record };
  }
  return { action: "sign", reason: "prior_authorization_expired_unused" };
}

/** Pulls nonce and validBefore out of an x402 exact EVM payment payload. */
export function authorizationFromPayload(payload: unknown): {
  nonce: Hex;
  validBefore: string;
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
} {
  const auth = (payload as { payload?: { authorization?: Record<string, unknown> } })?.payload?.authorization;
  const nonce = String(auth?.nonce ?? "");
  const validBefore = String(auth?.validBefore ?? "");
  const from = String(auth?.from ?? "");
  const to = String(auth?.to ?? "");
  const value = String(auth?.value ?? "");
  if (
    !/^0x[0-9a-fA-F]{64}$/.test(nonce) ||
    !/^\d+$/.test(validBefore) ||
    !/^0x[0-9a-fA-F]{40}$/.test(from) ||
    !/^0x[0-9a-fA-F]{40}$/.test(to) ||
    !/^\d+$/.test(value)
  ) {
    throw new Error("payment payload has no EIP-3009 authorization");
  }
  return { nonce: nonce as Hex, validBefore, from: from as `0x${string}`, to: to as `0x${string}`, value };
}

// ---------- bundle receipt ----------

export type VerdictReceipt = {
  input_sha256: string;
  verdict: string;
  as_of: string;
  signer: string;
  signature: string;
};

export type PaymentProof = {
  found: boolean;
  network: string;
  tx: string;
  block: string | null;
  from: string | null;
  to: string | null;
  asset?: string | null;
  amount?: string | null;
  status: string;
  [key: string]: unknown;
};

export type DeliveryClaim = {
  observed_by: "buyer";
  http_status: number;
  content_type: string | null;
  body_sha256: string;
  body_bytes: number;
  received_at: string;
};

export type BundleReceipt = {
  kind: "pay-guard.bundle.v1";
  presign: VerdictReceipt;
  payment_proof: PaymentProof;
  delivery_claim: DeliveryClaim;
  agent: `0x${string}`;
  agent_signature: Hex;
};

export const BUNDLE_STATEMENT =
  "vet402 signed the verdict before payment; vet402 read the payment on chain; delivery fields are the buyer's statement; this signature moves no funds";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function bundleMessage(body: Omit<BundleReceipt, "agent_signature">): string {
  const digest = createHash("sha256").update(canonicalJson(body)).digest("hex");
  return ["pay-guard.bundle.v1", `sha256: ${digest}`, BUNDLE_STATEMENT].join("\n");
}

export function deliveryClaimFromBody(params: {
  status: number;
  contentType: string | null;
  body: string;
  receivedAt?: Date;
}): DeliveryClaim {
  const bytes = Buffer.from(params.body, "utf8");
  return {
    observed_by: "buyer",
    http_status: params.status,
    content_type: params.contentType,
    body_sha256: createHash("sha256").update(bytes).digest("hex"),
    body_bytes: bytes.length,
    received_at: (params.receivedAt ?? new Date()).toISOString(),
  };
}

export async function fetchPaymentProof(params: {
  network: string;
  transaction: string;
  fetchImpl?: typeof fetch;
}): Promise<PaymentProof> {
  const resp = await (params.fetchImpl ?? fetch)(`${VET402_API_BASE}/api/v1/payment-proof`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ network: params.network, transaction: params.transaction }),
  });
  if (!resp.ok) throw new Error(`payment_proof_failed:${resp.status}`);
  return (await resp.json()) as PaymentProof;
}

export async function buildBundleReceipt(params: {
  presign: VerdictReceipt;
  paymentProof: PaymentProof;
  delivery: DeliveryClaim;
  agent: PrivateKeyAccount;
}): Promise<BundleReceipt> {
  const body = {
    kind: "pay-guard.bundle.v1" as const,
    presign: params.presign,
    payment_proof: params.paymentProof,
    delivery_claim: params.delivery,
    agent: params.agent.address,
  };
  const agent_signature = await params.agent.signMessage({ message: bundleMessage(body) });
  return { ...body, agent_signature };
}

/** vet402.com's verdict receipt signer (GET /api/v1/check → receipt.signer, read 2026-11-28). */
export const VET402_VERDICT_SIGNER = "0x01fF7F7BeF75c87F16a1C3De5E0F030829623117" as const;

export type BlockTimestampReader = (block: bigint) => Promise<number>;

export function createBlockTimestampReader(rpcUrl: string = CELO_MAINNET_RPC): BlockTimestampReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 8_000 }) });
  return async (blockNumber) => Number((await client.getBlock({ blockNumber })).timestamp);
}

export type BundleCheck = {
  ok: boolean;
  agent_signature: boolean;
  presign_from_vet402: boolean;
  presign_allow: boolean;
  presign_before_payment: boolean | "unreachable";
  presign_signature: boolean | "unreachable";
  payment_on_chain: boolean | "unreachable";
  payer_is_agent: boolean;
  problems: string[];
};

/**
 * Third-party check: agent signature, vet402's verdict signature (POST /api/v1/receipts/verify),
 * and a fresh chain read of the payment (POST /api/v1/payment-proof) that must match the bundle.
 */
export async function verifyBundleReceipt(
  bundle: BundleReceipt,
  fetchImpl: typeof fetch = fetch,
  opts: { expectedSigner?: string; readBlockTimestamp?: BlockTimestampReader } = {},
): Promise<BundleCheck> {
  const problems: string[] = [];
  // receipts/verify only checks the signature against the signer field, so pin vet402's key here.
  const fromVet402 = bundle.presign.signer.toLowerCase() === (opts.expectedSigner ?? VET402_VERDICT_SIGNER).toLowerCase();
  if (!fromVet402) problems.push("presign_signer_not_vet402");
  const allow = bundle.presign.verdict === "ALLOW";
  if (!allow) problems.push("presign_not_allow");
  const { agent_signature, ...body } = bundle;
  let agentOk = false;
  try {
    const recovered = await recoverMessageAddress({ message: bundleMessage(body), signature: agent_signature });
    agentOk = recovered.toLowerCase() === bundle.agent.toLowerCase();
  } catch {
    agentOk = false;
  }
  if (!agentOk) problems.push("agent_signature_invalid");

  let presignOk: boolean | "unreachable" = "unreachable";
  try {
    const r = await fetchImpl(`${VET402_API_BASE}/api/v1/receipts/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundle.presign),
    });
    const j = (await r.json()) as { ok?: boolean };
    presignOk = r.ok && j.ok === true;
  } catch {
    presignOk = "unreachable";
  }
  if (presignOk !== true) problems.push(presignOk === "unreachable" ? "presign_unreachable" : "presign_signature_invalid");

  let chainOk: boolean | "unreachable" = "unreachable";
  try {
    const fresh = await fetchPaymentProof({
      network: bundle.payment_proof.network,
      transaction: bundle.payment_proof.tx,
      fetchImpl,
    });
    const same = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
    chainOk =
      fresh.found === true &&
      fresh.status === "confirmed" &&
      ["tx", "block", "from", "to", "asset", "amount"].every((k) =>
        same((fresh as Record<string, unknown>)[k], (bundle.payment_proof as Record<string, unknown>)[k]),
      );
  } catch {
    chainOk = "unreachable";
  }
  if (chainOk !== true) problems.push(chainOk === "unreachable" ? "chain_unreachable" : "payment_mismatch");

  let before: boolean | "unreachable" = "unreachable";
  try {
    const block = bundle.payment_proof.block;
    if (bundle.payment_proof.network !== "eip155:42220") {
      before = false;
    } else if (block && /^\d+$/.test(block)) {
      const ts = await (opts.readBlockTimestamp ?? createBlockTimestampReader())(BigInt(block));
      before = Date.parse(bundle.presign.as_of) <= ts * 1000;
    }
  } catch {
    before = "unreachable";
  }
  if (before !== true) problems.push(before === "unreachable" ? "block_time_unreachable" : "presign_after_payment");

  const payerIsAgent = String(bundle.payment_proof.from ?? "").toLowerCase() === bundle.agent.toLowerCase();
  if (!payerIsAgent) problems.push("payer_is_not_agent");

  return {
    ok: agentOk && fromVet402 && allow && before === true && presignOk === true && chainOk === true && payerIsAgent,
    agent_signature: agentOk,
    presign_from_vet402: fromVet402,
    presign_allow: allow,
    presign_before_payment: before,
    presign_signature: presignOk,
    payment_on_chain: chainOk,
    payer_is_agent: payerIsAgent,
    problems,
  };
}
