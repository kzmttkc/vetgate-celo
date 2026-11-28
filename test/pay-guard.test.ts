import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { CELO_MAINNET_USDC } from "../src/chain.js";
import {
  EXPIRY_MARGIN_SEC,
  FileIntentStore,
  MemoryIntentStore,
  authorizationFromPayload,
  buildBundleReceipt,
  computeIntentKey,
  decideBeforeSigning,
  deliveryClaimFromBody,
  verifyBundleReceipt,
  type BundleReceipt,
  type IntentRecord,
  type PaymentProof,
} from "../src/pay-guard.js";
import { runDailyBuy, unloggedIntentUnits } from "../src/x402-buy-once.js";

const SELLER_PAYTO = "0x20faaca5f980e29639a0fcc6dca6988e18ed333b";
const TX = `0x${"c".repeat(64)}` as const;
const NONCE = `0x${"d".repeat(64)}` as const;
const PRESIGN = {
  input_sha256: "8".repeat(64),
  verdict: "ALLOW",
  as_of: "2026-11-28T00:00:00.000Z",
  signer: "0x01fF7F7BeF75c87F16a1C3De5E0F030829623117",
  signature: `0x${"e".repeat(130)}`,
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function record(over: Partial<IntentRecord> = {}): IntentRecord {
  return {
    intentKey: "a".repeat(64),
    payer: "0x970b37b3c58edc62cccb7beeab5972bc7c6b0435",
    payTo: SELLER_PAYTO,
    asset: CELO_MAINNET_USDC,
    units: "5000",
    nonce: NONCE,
    validBefore: "2000",
    status: "signed",
    signedAt: "2099-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("idempotency: decideBeforeSigning", () => {
  const key = "a".repeat(64);
  const unused = async () => false;
  const used = async () => true;

  it("signs when there is no prior intent", async () => {
    const d = await decideBeforeSigning({ store: new MemoryIntentStore(), intentKey: key, readAuthorizationState: unused });
    expect(d).toEqual({ action: "sign", reason: "no_prior_intent" });
  });

  it("stops when the prior intent settled", async () => {
    const store = new MemoryIntentStore();
    store.put(record({ status: "settled", txHash: TX }));
    const d = await decideBeforeSigning({ store, intentKey: key, readAuthorizationState: unused });
    expect(d.action).toBe("stop");
    expect(d.reason).toBe("already_paid");
  });

  it("stops when the chain says the signed authorization was used (crash after send)", async () => {
    const store = new MemoryIntentStore();
    store.put(record());
    const d = await decideBeforeSigning({ store, intentKey: key, readAuthorizationState: used, nowSec: 1000 });
    expect(d.reason).toBe("already_paid");
  });

  it("stops while an unused authorization can still be settled by someone else", async () => {
    const store = new MemoryIntentStore();
    store.put(record({ validBefore: "2000" }));
    const d = await decideBeforeSigning({ store, intentKey: key, readAuthorizationState: unused, nowSec: 1000 });
    expect(d).toMatchObject({ action: "stop", reason: "prior_authorization_still_valid" });
  });

  it("signs again only after the unused authorization expired, with a margin for clock and RPC lag", async () => {
    const store = new MemoryIntentStore();
    store.put(record({ validBefore: "2000" }));
    const justAfter = await decideBeforeSigning({ store, intentKey: key, readAuthorizationState: unused, nowSec: 2001 });
    expect(justAfter.reason).toBe("prior_authorization_still_valid");
    const d = await decideBeforeSigning({
      store,
      intentKey: key,
      readAuthorizationState: unused,
      nowSec: 2000 + EXPIRY_MARGIN_SEC + 1,
    });
    expect(d).toEqual({ action: "sign", reason: "prior_authorization_expired_unused" });
  });

  it("an unresolved authorization under another key blocks a new one", async () => {
    const store = new MemoryIntentStore();
    store.put(record({ intentKey: "b".repeat(64), validBefore: "2000" }));
    const d = await decideBeforeSigning({ store, intentKey: key, readAuthorizationState: unused, nowSec: 1000 });
    expect(d).toMatchObject({ action: "stop", reason: "other_intent_unresolved" });
  });

  it("stops when the chain cannot be read (never pays on unknown)", async () => {
    const store = new MemoryIntentStore();
    store.put(record());
    const d = await decideBeforeSigning({
      store,
      intentKey: key,
      readAuthorizationState: async () => {
        throw new Error("rpc down");
      },
    });
    expect(d.reason).toBe("authorization_state_unknown");
  });

  it("keys the intent by UTC day and payer only (seller or price changes keep the same key)", () => {
    const base = { day: "2099-01-01", payer: SELLER_PAYTO };
    expect(computeIntentKey(base)).toBe(computeIntentKey({ ...base, payer: SELLER_PAYTO.toUpperCase().replace("0X", "0x") }));
    expect(computeIntentKey(base)).not.toBe(computeIntentKey({ ...base, day: "2099-01-02" }));
  });

  it("file store round-trips, lists, locks, and refuses a path-like key", () => {
    const store = new FileIntentStore(mkdtempSync(join(tmpdir(), "intents-")));
    store.put(record());
    expect(store.get("a".repeat(64))?.nonce).toBe(NONCE);
    expect(store.list()).toHaveLength(1);
    expect(() => store.get("../x")).toThrow(/invalid intent key/);
    const unlock = store.lock();
    expect(() => store.lock()).toThrow();
    unlock();
    store.lock()();
  });

  it("takes over a lock left by a dead process, but not one held by a live process", () => {
    const dir = mkdtempSync(join(tmpdir(), "intents-"));
    writeFileSync(join(dir, ".lock"), JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
    const store = new FileIntentStore(dir);
    const unlock = store.lock();
    unlock();
    writeFileSync(join(dir, ".lock"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    expect(() => store.lock()).toThrow(/held by pid/);
  });

  it("settles an older paid intent and still lets today's buy sign; expired ones stop counting", async () => {
    const store = new MemoryIntentStore();
    store.put(record({ intentKey: "b".repeat(64), nonce: `0x${"1".repeat(64)}` }));
    store.put(record({ intentKey: "c".repeat(64), nonce: `0x${"2".repeat(64)}`, validBefore: "10" }));
    const d = await decideBeforeSigning({
      store,
      intentKey: key,
      readAuthorizationState: async ({ nonce }) => nonce === `0x${"1".repeat(64)}`,
      nowSec: 5000,
    });
    expect(d).toEqual({ action: "sign", reason: "no_prior_intent" });
    expect(store.get("b".repeat(64))?.status).toBe("settled");
    expect(store.get("c".repeat(64))?.status).toBe("expired");
    expect(unloggedIntentUnits(store)).toBe(5000n);
  });

  it("a record that cannot be parsed stops instead of reading as no record", () => {
    const dir = mkdtempSync(join(tmpdir(), "intents-"));
    writeFileSync(join(dir, `${"a".repeat(64)}.json`), "{broken");
    expect(() => new FileIntentStore(dir).get("a".repeat(64))).toThrow();
  });

  it("reads nonce and validBefore from an x402 exact payload", () => {
    const auth = authorizationFromPayload({
      payload: { authorization: { from: SELLER_PAYTO, to: SELLER_PAYTO, value: "5000", nonce: NONCE, validBefore: "123" } },
    });
    expect(auth).toEqual({ from: SELLER_PAYTO, to: SELLER_PAYTO, value: "5000", nonce: NONCE, validBefore: "123" });
    expect(() => authorizationFromPayload({ payload: {} })).toThrow();
  });
});

describe("bundle receipt (pay-guard.bundle.v1)", () => {
  const agent = privateKeyToAccount(generatePrivateKey());
  const proof: PaymentProof = {
    found: true,
    network: "eip155:42220",
    tx: TX,
    block: "1",
    from: agent.address.toLowerCase(),
    to: SELLER_PAYTO,
    asset: CELO_MAINNET_USDC.toLowerCase(),
    amount: "5000",
    status: "confirmed",
  };

  function vet402(opts: { presignOk?: boolean; chain?: Partial<PaymentProof> } = {}): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/receipts/verify")) return json({ ok: opts.presignOk ?? true });
      if (url.endsWith("/api/v1/payment-proof")) return json({ ...proof, ...opts.chain });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
  }

  async function bundle(): Promise<BundleReceipt> {
    return buildBundleReceipt({
      presign: PRESIGN,
      paymentProof: proof,
      delivery: deliveryClaimFromBody({ status: 200, contentType: "application/json", body: '{"ok":1}' }),
      agent,
    });
  }

  const LATER = { readBlockTimestamp: async () => Date.parse("2026-11-28T01:00:00Z") / 1000 };

  it("refuses a verdict signed by someone other than vet402, a non-ALLOW verdict, or one issued after payment", async () => {
    const forged = await buildBundleReceipt({
      presign: { ...PRESIGN, signer: agent.address },
      paymentProof: proof,
      delivery: deliveryClaimFromBody({ status: 200, contentType: null, body: "" }),
      agent,
    });
    expect((await verifyBundleReceipt(forged, vet402(), LATER)).problems).toContain("presign_signer_not_vet402");
    const warn = await buildBundleReceipt({
      presign: { ...PRESIGN, verdict: "WARN" },
      paymentProof: proof,
      delivery: deliveryClaimFromBody({ status: 200, contentType: null, body: "" }),
      agent,
    });
    expect((await verifyBundleReceipt(warn, vet402(), LATER)).problems).toContain("presign_not_allow");
    const early = { readBlockTimestamp: async () => Date.parse("2026-11-27T00:00:00Z") / 1000 };
    expect((await verifyBundleReceipt(await bundle(), vet402(), early)).problems).toContain("presign_after_payment");
  });

  it("records the body hash and size, not the body", () => {
    const d = deliveryClaimFromBody({ status: 200, contentType: "text/plain", body: "héllo" });
    expect(d.body_bytes).toBe(6);
    expect(d.body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(d)).not.toContain("héllo");
  });

  it("verifies end to end", async () => {
    const r = await verifyBundleReceipt(await bundle(), vet402(), LATER);
    expect(r).toMatchObject({ ok: true, problems: [] });
  });

  it("catches an edited delivery claim", async () => {
    const b = await bundle();
    b.delivery_claim.http_status = 500;
    const r = await verifyBundleReceipt(b, vet402(), LATER);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain("agent_signature_invalid");
  });

  it("catches a verdict vet402 did not sign", async () => {
    const r = await verifyBundleReceipt(await bundle(), vet402({ presignOk: false }), LATER);
    expect(r.problems).toContain("presign_signature_invalid");
  });

  it("catches a payment the chain does not show the same way", async () => {
    const r = await verifyBundleReceipt(await bundle(), vet402({ chain: { amount: "6000" } }), LATER);
    expect(r.problems).toContain("payment_mismatch");
  });

  it("says unreachable instead of ok when vet402 cannot be read", async () => {
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const r = await verifyBundleReceipt(await bundle(), down, LATER);
    expect(r.ok).toBe(false);
    expect(r.presign_signature).toBe("unreachable");
    expect(r.payment_on_chain).toBe("unreachable");
  });
});

describe("daily buy with the guard (mocked seller and facilitator)", () => {
  const payerPk = generatePrivateKey();
  const payer = privateKeyToAccount(payerPk).address;
  const future = new Date("2099-01-01T00:00:00Z");

  function seller(opts: { dropPaidResponse?: boolean; amount?: string; payToAtPayment?: string }) {
    let paidCalls = 0;
    let quotes = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("vet402.com/api/v1/check")) {
        return json({
          recommendation: "ALLOW",
          verified_pay_to_by_network: [{ network: "eip155:42220", payTo: SELLER_PAYTO }],
          receipt: PRESIGN,
        });
      }
      if (url.endsWith("/api/v1/payment-proof")) {
        return json({
          found: true,
          network: "eip155:42220",
          tx: TX,
          block: "1",
          from: payer.toLowerCase(),
          to: SELLER_PAYTO,
          asset: CELO_MAINNET_USDC.toLowerCase(),
          amount: "5000",
          status: "confirmed",
        });
      }
      if (url.includes("gateway.usebuy.ai")) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const paying = Object.keys(headers).some((h) => /payment|x-payment/i.test(h));
        if (!paying) {
          quotes += 1;
          return json(
            {
              x402Version: 1,
              accepts: [
                {
                  scheme: "exact",
                  network: "celo",
                  maxAmountRequired: opts.amount ?? "5000",
                  resource: url,
                  payTo: quotes > 1 && opts.payToAtPayment ? opts.payToAtPayment : SELLER_PAYTO,
                  maxTimeoutSeconds: 300,
                  asset: CELO_MAINNET_USDC,
                  extra: { name: "USDC", version: "2" },
                },
              ],
            },
            402,
          );
        }
        paidCalls += 1;
        if (opts.dropPaidResponse) throw new Error("socket hang up");
        const settle = Buffer.from(
          JSON.stringify({ success: true, transaction: TX, network: "celo", payer }),
        ).toString("base64");
        return json({ profile: "ok" }, 200, { "X-PAYMENT-RESPONSE": settle });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    return { fetchImpl, paid: () => paidCalls };
  }

  it("pays once, marks the intent settled and writes a bundle that verifies", async () => {
    const store = new MemoryIntentStore();
    const evidenceDir = mkdtempSync(join(tmpdir(), "daily-"));
    const s = seller({});
    const r = await runDailyBuy({
      live: true,
      payerPrivateKey: payerPk,
      fetchImpl: s.fetchImpl,
      now: future,
      intentStore: store,
      readAuthorizationState: async () => false,
      evidenceDir,
      recordRun: false,
    });
    expect(r.mode).toBe("live");
    expect(s.paid()).toBe(1);
    expect([...store.records.values()][0]?.status).toBe("settled");
    if (r.mode !== "live") return;
    expect(r.bundlePath && existsSync(r.bundlePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(r.bundlePath!, "utf8")) as BundleReceipt;
    expect(onDisk.kind).toBe("pay-guard.bundle.v1");
    const check = await verifyBundleReceipt(onDisk, (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/receipts/verify") ? json({ ok: true }) : s.fetchImpl(input, init)) as typeof fetch, {
      readBlockTimestamp: async () => Date.parse("2026-11-28T01:00:00Z") / 1000,
    });
    expect(check).toMatchObject({ ok: true });

    // A second run the same day stops before signing.
    const again = await runDailyBuy({
      live: true,
      payerPrivateKey: payerPk,
      fetchImpl: s.fetchImpl,
      now: future,
      intentStore: store,
      readAuthorizationState: async () => false,
      evidenceDir,
      recordRun: false,
    });
    expect(again).toMatchObject({ mode: "stopped", reason: "already_paid" });
    expect(s.paid()).toBe(1);
  });

  it("after a dropped connection, the retry asks the chain and does not sign a second payment", async () => {
    const store = new MemoryIntentStore();
    const evidenceDir = mkdtempSync(join(tmpdir(), "daily-"));
    const broken = seller({ dropPaidResponse: true });
    await expect(
      runDailyBuy({
        live: true,
        payerPrivateKey: payerPk,
        fetchImpl: broken.fetchImpl,
        now: future,
        intentStore: store,
        readAuthorizationState: async () => false,
        evidenceDir,
        recordRun: false,
      }),
    ).rejects.toThrow(/socket hang up/);
    const saved = [...store.records.values()][0]!;
    expect(saved.status).toBe("signed");

    const seen: string[] = [];
    const healthy = seller({});
    const retry = await runDailyBuy({
      live: true,
      payerPrivateKey: payerPk,
      fetchImpl: healthy.fetchImpl,
      now: future,
      intentStore: store,
      readAuthorizationState: async ({ nonce }) => {
        seen.push(nonce);
        return true; // the facilitator did settle the first one
      },
      evidenceDir,
      recordRun: false,
    });
    expect(retry).toMatchObject({ mode: "stopped", reason: "already_paid" });
    expect(seen).toEqual([saved.nonce]);
    expect(healthy.paid()).toBe(0);
  });

  it("refuses when the 402 at payment time switches payTo, and signs nothing", async () => {
    const store = new MemoryIntentStore();
    const s = seller({ payToAtPayment: `0x${"1".repeat(40)}` });
    await expect(
      runDailyBuy({
        live: true,
        payerPrivateKey: payerPk,
        fetchImpl: s.fetchImpl,
        now: future,
        intentStore: store,
        readAuthorizationState: async () => false,
        evidenceDir: mkdtempSync(join(tmpdir(), "daily-")),
        recordRun: false,
      }),
    ).rejects.toThrow(/no longer matches/);
    expect(s.paid()).toBe(0);
    expect(store.list()).toHaveLength(0);
  });

  it("a crash, then a retry where the price changed, still asks the chain first and settles the record", async () => {
    const store = new MemoryIntentStore();
    const evidenceDir = mkdtempSync(join(tmpdir(), "daily-"));
    await expect(
      runDailyBuy({
        live: true,
        payerPrivateKey: payerPk,
        fetchImpl: seller({ dropPaidResponse: true }).fetchImpl,
        now: future,
        intentStore: store,
        readAuthorizationState: async () => false,
        evidenceDir,
        recordRun: false,
      }),
    ).rejects.toThrow(/socket hang up/);
    expect(unloggedIntentUnits(store)).toBe(5000n);
    const cheaper = seller({ amount: "4000" });
    const retry = await runDailyBuy({
      live: true,
      payerPrivateKey: payerPk,
      fetchImpl: cheaper.fetchImpl,
      now: future,
      intentStore: store,
      readAuthorizationState: async () => true,
      evidenceDir,
      recordRun: false,
    });
    expect(retry).toMatchObject({ mode: "stopped", reason: "already_paid" });
    expect(cheaper.paid()).toBe(0);
    expect(store.list()[0]?.status).toBe("settled");
    expect(unloggedIntentUnits(store)).toBe(5000n);
  });
});
