import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { keccak256, stringToHex, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import {
  CELO_MAINNET_CAIP2,
  CELO_MAINNET_CHAIN_ID,
  CELO_MAINNET_RPC,
  CELO_MAINNET_USDC,
  resolveAttributionCode,
  resolveCeloRuntime,
} from "./chain.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  appendTxRow,
  assertStepNotDone,
  dailyBuySpentUnits,
  isDailyBuyDoneUtc,
  utcDayStamp,
} from "./mainnet-run-log.js";
import {
  BUILTIN_CANDIDATE_SELLER_URLS,
  resolveMainnetSellerPayTo,
  type ResolvedMainnetSeller,
} from "./mainnet-seller.js";
import {
  FileIntentStore,
  authorizationFromPayload,
  buildBundleReceipt,
  computeIntentKey,
  createAuthorizationStateReader,
  decideBeforeSigning,
  deliveryClaimFromBody,
  fetchPaymentProof,
  type AuthorizationStateReader,
  type BundleReceipt,
  type IntentStore,
} from "./pay-guard.js";

/** Max x402 purchase: 0.05 USDC (6 decimals). */
export const BUY_ONCE_MAX_USDC_UNITS = 50_000n;

export type X402V1Accept = {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  asset: string;
  extra?: Record<string, unknown>;
};

export type X402V1PaymentRequired = {
  x402Version?: number;
  error?: string;
  accepts: X402V1Accept[];
};

export type BuyOnceHttpRequest = {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: string;
};

export type SelectedX402Quote = {
  sellerUrl: string;
  /** Paid / quote HTTP target (POST body URL or probed GET URL). */
  requestUrl: string;
  httpRequest: BuyOnceHttpRequest;
  accept: X402V1Accept;
  paymentRequired: X402V1PaymentRequired;
};

export type Eip3009SignPreview = {
  primaryType: "TransferWithAuthorization";
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: `0x${string}`;
  };
  message: {
    from: `0x${string}`;
    to: `0x${string}`;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: `0x${string}`;
  };
  attributionTag: string;
  note: string;
};

export function isCeloMainnetNetwork(network: string): boolean {
  const n = network.toLowerCase();
  return (
    n === "celo" ||
    n === "eip155:42220" ||
    n === "42220" ||
    n === CELO_MAINNET_CAIP2.toLowerCase()
  );
}

export function parseUsdcUnits(amount: string): bigint {
  if (!/^\d+$/.test(amount)) {
    throw new Error(`invalid maxAmountRequired: ${amount}`);
  }
  return BigInt(amount);
}

export function assertBuyOncePriceCap(units: bigint): void {
  if (units > BUY_ONCE_MAX_USDC_UNITS) {
    throw new Error(
      `refused: price ${units} units exceeds cap ${BUY_ONCE_MAX_USDC_UNITS} (0.05 USDC)`,
    );
  }
}

export function paymentRequirementUnits(requirement: PaymentRequirements): bigint {
  const raw =
    requirement.amount ??
    ("maxAmountRequired" in requirement
      ? (requirement as PaymentRequirements & { maxAmountRequired?: string }).maxAmountRequired
      : undefined);
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new Error(`invalid payment amount: ${String(raw)}`);
  }
  return BigInt(raw);
}

/** Restricts accepts to exact Celo mainnet offers within the 0.05 USDC cap. */
export function buyOncePaymentPolicy(
  _version: number,
  requirements: PaymentRequirements[],
): PaymentRequirements[] {
  return requirements.filter((requirement) => {
    if (requirement.scheme !== "exact") return false;
    if (!isCeloMainnetNetwork(requirement.network)) return false;
    try {
      assertBuyOncePriceCap(paymentRequirementUnits(requirement));
      return true;
    } catch {
      return false;
    }
  });
}

export function createBuyOnceX402Client(account: PrivateKeyAccount): x402Client {
  const client = new x402Client();
  client.setSpendControls({ maxAmountPerPayment: "0.05" });
  registerExactEvmScheme(client, {
    signer: toClientEvmSigner(account),
    networks: [CELO_MAINNET_CAIP2],
    schemeOptions: { rpcUrl: CELO_MAINNET_RPC },
    policies: [buyOncePaymentPolicy],
  });
  return client;
}

export async function buildBuyOnceV2PaymentPayload(params: {
  httpRequest: BuyOnceHttpRequest;
  payerPrivateKey: `0x${string}`;
  fetchImpl?: typeof fetch;
}): Promise<PaymentPayload> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const account = privateKeyToAccount(params.payerPrivateKey);
  const coreClient = createBuyOnceX402Client(account);
  const httpClient = new x402HTTPClient(coreClient);

  const response = await fetchImpl(
    params.httpRequest.url,
    mergeBuyOnceFetchInit(params.httpRequest),
  );
  if (response.status !== 402) {
    throw new Error(`expected HTTP 402 before payment payload build, got ${response.status}`);
  }

  const bodyText = await response.text();
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name) => response.headers.get(name),
    JSON.parse(bodyText),
  );

  if (paymentRequired.x402Version !== 2) {
    throw new Error(`expected x402 v2 payment required, got version ${paymentRequired.x402Version}`);
  }

  const payload = await httpClient.createPaymentPayload(paymentRequired);
  if (payload.x402Version !== 2) {
    throw new Error(`expected x402 v2 payment payload, got version ${payload.x402Version}`);
  }

  const accepted = payload.accepted;
  if (!accepted || !isCeloMainnetNetwork(accepted.network)) {
    throw new Error(`refused: payment payload network ${accepted?.network ?? "missing"} is not Celo mainnet`);
  }
  assertBuyOncePriceCap(paymentRequirementUnits(accepted));

  return payload;
}

export function selectCeloMainnetAccept(
  paymentRequired: X402V1PaymentRequired,
  preferAsset?: `0x${string}`,
): X402V1Accept {
  const candidates = paymentRequired.accepts.filter(
    (a) => a.scheme === "exact" && isCeloMainnetNetwork(a.network),
  );
  if (candidates.length === 0) {
    throw new Error("refused: no exact Celo mainnet accept in 402 response");
  }
  const asset = (preferAsset ?? CELO_MAINNET_USDC).toLowerCase();
  const preferred =
    candidates.find((c) => c.asset.toLowerCase() === asset) ?? candidates[0]!;
  const units = parseUsdcUnits(preferred.maxAmountRequired);
  assertBuyOncePriceCap(units);
  return preferred;
}

export function probeUrlForSeller(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.hostname === "gateway.usebuy.ai") {
    if (url.pathname.includes("/tiktok/profile") && !url.searchParams.has("username")) {
      url.searchParams.set("username", "cursor");
    }
    if (url.pathname.includes("/instagram/profile") && !url.searchParams.has("username")) {
      url.searchParams.set("username", "cursor");
    }
  }
  return url.toString();
}

/**
 * usebuy social profile APIs require POST + JSON body for paid replay;
 * GET with query only works for the unpaid 402 quote in some gateways.
 */
export function buildBuyOnceHttpRequest(sellerUrl: string): BuyOnceHttpRequest {
  const parsed = new URL(sellerUrl);
  if (parsed.hostname === "gateway.usebuy.ai") {
    if (
      parsed.pathname.includes("/tiktok/profile") ||
      parsed.pathname.includes("/instagram/profile")
    ) {
      const username = parsed.searchParams.get("username") ?? "cursor";
      return {
        method: "POST",
        url: `${parsed.origin}${parsed.pathname}`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username }),
      };
    }
  }
  return { method: "GET", url: probeUrlForSeller(sellerUrl) };
}

function mergeBuyOnceFetchInit(
  req: BuyOnceHttpRequest,
  extraHeaders?: Record<string, string>,
): RequestInit {
  return {
    method: req.method,
    headers: { ...req.headers, ...extraHeaders },
    body: req.method === "POST" ? req.body : undefined,
    redirect: "follow",
  };
}

/** Safe stderr diagnostics when settlement headers are missing (no secrets). */
export function logBuyOncePaidDiagnostics(params: {
  httpRequest: BuyOnceHttpRequest;
  sentPaymentHeaderNames: string[];
  paymentPayload: PaymentPayload;
  response: Response;
  bodyPreview: string;
}): void {
  const paymentHeaders: Record<string, string> = {};
  params.response.headers.forEach((value, name) => {
    if (/payment/i.test(name)) {
      paymentHeaders[name] = `${value.length} b64 chars`;
    }
  });
  const accepted = params.paymentPayload.accepted;
  console.error(
    JSON.stringify(
      {
        buyOncePaidDiagnostics: {
          request: {
            method: params.httpRequest.method,
            url: params.httpRequest.url,
            hasBody: Boolean(params.httpRequest.body),
          },
          sentPaymentHeaderNames: params.sentPaymentHeaderNames,
          payloadAccepted: accepted
            ? {
                network: accepted.network,
                amount: accepted.amount,
                asset: accepted.asset,
                payTo: accepted.payTo,
              }
            : null,
          paidHttpStatus: params.response.status,
          responsePaymentHeaders: paymentHeaders,
          bodyFirst300: params.bodyPreview.slice(0, 300),
        },
      },
      null,
      2,
    ),
  );
}

export function buildEip3009SignPreview(params: {
  accept: X402V1Accept;
  payer: `0x${string}`;
  nowSec?: number;
}): Eip3009SignPreview {
  const now = params.nowSec ?? Math.floor(Date.now() / 1000);
  const timeout = params.accept.maxTimeoutSeconds ?? 300;
  const extra = params.accept.extra ?? {};
  const name = String(extra.name ?? "USDC");
  const version = String(extra.version ?? "2");
  const nonce = `0x${"00".repeat(32)}` as `0x${string}`;
  return {
    primaryType: "TransferWithAuthorization",
    domain: {
      name,
      version,
      chainId: CELO_MAINNET_CHAIN_ID,
      verifyingContract: params.accept.asset as `0x${string}`,
    },
    message: {
      from: params.payer,
      to: params.accept.payTo as `0x${string}`,
      value: params.accept.maxAmountRequired,
      validAfter: String(now - 60),
      validBefore: String(now + timeout),
      nonce,
    },
    attributionTag: resolveAttributionCode(),
    note:
      "EIP-3009 TransferWithAuthorization via x402 exact. Nonce and validity window are filled by the x402 client at signing time.",
  };
}

export async function fetchPaymentRequired(
  httpRequest: BuyOnceHttpRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; paymentRequired: X402V1PaymentRequired }> {
  const resp = await fetchImpl(httpRequest.url, mergeBuyOnceFetchInit(httpRequest));
  const text = await resp.text();
  let body: X402V1PaymentRequired;
  try {
    body = JSON.parse(text) as X402V1PaymentRequired;
  } catch {
    throw new Error(
      `expected JSON 402 body from ${httpRequest.method} ${httpRequest.url}, got status ${resp.status}`,
    );
  }
  if (!Array.isArray(body.accepts)) {
    throw new Error(`missing accepts[] in 402 body (status ${resp.status})`);
  }
  return { status: resp.status, paymentRequired: body };
}

export async function quoteCheapestSeller(
  seller: ResolvedMainnetSeller,
  fetchImpl: typeof fetch = fetch,
): Promise<SelectedX402Quote> {
  const httpRequest = buildBuyOnceHttpRequest(seller.sellerUrl);
  const { status, paymentRequired } = await fetchPaymentRequired(httpRequest, fetchImpl);
  if (status !== 402) {
    throw new Error(`expected HTTP 402 from seller, got ${status}`);
  }
  const accept = selectCeloMainnetAccept(paymentRequired, CELO_MAINNET_USDC);
  return {
    sellerUrl: seller.sellerUrl,
    requestUrl: httpRequest.url,
    httpRequest,
    accept,
    paymentRequired,
  };
}

export async function discoverCheapestUsefulQuote(
  fetchImpl: typeof fetch = fetch,
): Promise<SelectedX402Quote> {
  const urls = [
    ...(process.env.VETGATE_MAINNET_SELLER_URLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("https://")),
    ...BUILTIN_CANDIDATE_SELLER_URLS,
  ];
  const seen = new Set<string>();
  let best: SelectedX402Quote | undefined;

  for (const sellerUrl of urls) {
    const key = sellerUrl.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const quote = await quoteCheapestSeller({ payTo: "0x0", sellerUrl, source: "vet402" }, fetchImpl);
      const units = parseUsdcUnits(quote.accept.maxAmountRequired);
      if (!best || units < parseUsdcUnits(best.accept.maxAmountRequired)) {
        best = quote;
      }
    } catch {
      continue;
    }
  }

  if (best) return best;

  const seller = await resolveMainnetSellerPayTo(fetchImpl);
  return quoteCheapestSeller(seller, fetchImpl);
}

export type BuyOnceDryResult = {
  mode: "dry";
  quote: SelectedX402Quote;
  eip3009: Eip3009SignPreview;
  paymentPayloadV2?: PaymentPayload;
};

export async function runBuyOnceDry(params: {
  payer: `0x${string}`;
  payerPrivateKey?: `0x${string}`;
  includeSignedPayload?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<BuyOnceDryResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const quote = await discoverCheapestUsefulQuote(fetchImpl);
  const eip3009 = buildEip3009SignPreview({ accept: quote.accept, payer: params.payer });
  if (!params.includeSignedPayload) {
    return { mode: "dry", quote, eip3009 };
  }
  if (!params.payerPrivateKey) {
    throw new Error(
      "missing operator key for signed payload (VETGATE_ORACLE_SIGNER_PK or .secrets/mainnet-admin.key)",
    );
  }
  const paymentPayloadV2 = await buildBuyOnceV2PaymentPayload({
    httpRequest: quote.httpRequest,
    payerPrivateKey: params.payerPrivateKey,
    fetchImpl,
  });
  return { mode: "dry", quote, eip3009, paymentPayloadV2 };
}

type PaidPurchase = {
  responseHash: Hex;
  txHash: `0x${string}`;
  quote: SelectedX402Quote;
  status: number;
  body: string;
  contentType: string | null;
  receivedAt: Date;
};

export type PurchaseGuard = {
  store: IntentStore;
  intentKey: string;
};

async function purchaseWithQuote(params: {
  payerPrivateKey: `0x${string}`;
  quote: SelectedX402Quote;
  fetchImpl: typeof fetch;
  guard?: PurchaseGuard;
}): Promise<PaidPurchase> {
  const { quote, fetchImpl, guard } = params;
  const account = privateKeyToAccount(params.payerPrivateKey);
  const coreClient = createBuyOnceX402Client(account);
  const httpClient = new x402HTTPClient(coreClient);

  const { httpRequest } = quote;
  let response = await fetchImpl(httpRequest.url, mergeBuyOnceFetchInit(httpRequest));
  if (response.status !== 402) {
    throw new Error(`expected 402 before payment, got ${response.status}`);
  }

  const bodyText = await response.text();
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name) => response.headers.get(name),
    JSON.parse(bodyText),
  );

  // The second 402 must offer the same payTo and asset, at no more than the quoted price.
  const quotedUnits = parseUsdcUnits(quote.accept.maxAmountRequired);
  const offers = (paymentRequired.accepts as PaymentRequirements[]).filter((r) => {
    const units = (() => {
      try {
        return paymentRequirementUnits(r);
      } catch {
        return undefined;
      }
    })();
    return (
      String(r.payTo).toLowerCase() === quote.accept.payTo.toLowerCase() &&
      String(r.asset).toLowerCase() === quote.accept.asset.toLowerCase() &&
      units !== undefined &&
      units <= quotedUnits
    );
  });
  if (offers.length === 0) {
    throw new Error("refused: the 402 at payment time no longer matches the quoted payTo, asset or price");
  }
  paymentRequired.accepts = offers;
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  {
    const auth = authorizationFromPayload(paymentPayload);
    if (auth.to.toLowerCase() !== quote.accept.payTo.toLowerCase() || BigInt(auth.value) > quotedUnits) {
      throw new Error("refused: signed authorization does not match the quoted payTo or price");
    }
  }
  if (guard) {
    // Record the signed authorization before it leaves this process, so a retry can ask the chain about it.
    const auth = authorizationFromPayload(paymentPayload);
    const accepted = paymentPayload.accepted;
    guard.store.put({
      intentKey: guard.intentKey,
      payer: auth.from,
      payTo: String(accepted?.payTo ?? quote.accept.payTo) as `0x${string}`,
      asset: String(accepted?.asset ?? quote.accept.asset) as `0x${string}`,
      units: (accepted ? paymentRequirementUnits(accepted) : parseUsdcUnits(quote.accept.maxAmountRequired)).toString(),
      nonce: auth.nonce,
      validBefore: auth.validBefore,
      status: "signed",
      signedAt: new Date().toISOString(),
    });
  }
  const payHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  response = await fetchImpl(
    httpRequest.url,
    mergeBuyOnceFetchInit(httpRequest, payHeaders),
  );

  const paidBody = await response.text();
  const receivedAt = new Date();
  const responseHash = keccak256(stringToHex(paidBody));

  let settle;
  try {
    settle = httpClient.getPaymentSettleResponse((name) => response.headers.get(name));
  } catch (err) {
    logBuyOncePaidDiagnostics({
      httpRequest,
      sentPaymentHeaderNames: Object.keys(payHeaders),
      paymentPayload,
      response,
      bodyPreview: paidBody,
    });
    throw err;
  }
  const txHash = (settle?.transaction ?? "0x0") as `0x${string}`;
  if (!txHash || txHash === "0x0") {
    throw new Error("payment completed but settlement transaction hash missing");
  }
  if (guard) {
    try {
      const prior = guard.store.get(guard.intentKey);
      if (prior) guard.store.put({ ...prior, status: "settled", txHash, settledAt: new Date().toISOString() });
    } catch (err) {
      // Paid already. The record stays "signed", so the next run asks the chain and stops; keep going to log the tx.
      console.error(`daily_buy: intent not marked settled: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    responseHash,
    txHash,
    quote,
    status: response.status,
    body: paidBody,
    contentType: response.headers.get("content-type"),
    receivedAt,
  };
}

export async function runBuyOnceLive(params: {
  payerPrivateKey: `0x${string}`;
  fetchImpl?: typeof fetch;
}): Promise<{ responseHash: Hex; txHash: `0x${string}`; quote: SelectedX402Quote }> {
  assertStepNotDone("buy_purchase");
  const fetchImpl = params.fetchImpl ?? fetch;
  const quote = await discoverCheapestUsefulQuote(fetchImpl);
  const paid = await purchaseWithQuote({ payerPrivateKey: params.payerPrivateKey, quote, fetchImpl });

  appendTxRow(
    "buy_purchase",
    paid.txHash,
    `x402 usebuy bodySha256=${paid.responseHash} units=${quote.accept.maxAmountRequired}`,
  );

  return { responseHash: paid.responseHash, txHash: paid.txHash, quote };
}

/** Daily purchase: at most 0.005 USDC per call. */
export const DAILY_BUY_MAX_UNITS = 5_000n;
/** All daily purchases together stay under 0.1 USDC. */
export const DAILY_BUY_TOTAL_CAP_UNITS = 100_000n;
export const DAILY_BUY_EVIDENCE_DIR = join(process.cwd(), "evidence", "daily-buy");
/** Signed-but-maybe-unsettled authorizations, one file per intent (nonces are public once used). */
export const DAILY_BUY_INTENT_DIR = join(process.cwd(), "evidence", "daily-buy", "intents");

export type DailyBuyResult =
  | { mode: "skip"; reason: string; day: string }
  | {
      mode: "live" | "dry";
      day: string;
      sellerUrl: string;
      units: bigint;
      txHash?: `0x${string}`;
      responseHash?: Hex;
      evidencePath?: string;
      bundlePath?: string;
      bundle?: BundleReceipt;
    }
  | { mode: "stopped"; day: string; reason: string; intentKey: string; txHash?: `0x${string}` };

/** Throws when this purchase would break the per-call or total cap. */
export function assertDailyBuyBudget(units: bigint, spentUnits: bigint): void {
  if (units > DAILY_BUY_MAX_UNITS) {
    throw new Error(`refused: daily buy price ${units} units is above ${DAILY_BUY_MAX_UNITS}`);
  }
  if (spentUnits + units > DAILY_BUY_TOTAL_CAP_UNITS) {
    throw new Error(
      `refused: daily buys would reach ${spentUnits + units} units (cap ${DAILY_BUY_TOTAL_CAP_UNITS})`,
    );
  }
}

/**
 * Once per UTC day: ask vet402 about the seller, and only on ALLOW buy one x402 call
 * through Celo's facilitator. The paid response is kept under evidence/daily-buy/.
 */
export async function runDailyBuy(params: {
  payerPrivateKey?: `0x${string}`;
  live: boolean;
  fetchImpl?: typeof fetch;
  now?: Date;
  intentStore?: IntentStore;
  readAuthorizationState?: AuthorizationStateReader;
  evidenceDir?: string;
  recordRun?: boolean;
}): Promise<DailyBuyResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const day = utcDayStamp(params.now);
  const recordRun = params.recordRun ?? true;
  const evidenceDir = params.evidenceDir ?? DAILY_BUY_EVIDENCE_DIR;
  if (isDailyBuyDoneUtc(day)) {
    return { mode: "skip", reason: "already recorded", day };
  }
  const seller = await resolveMainnetSellerPayTo(fetchImpl);
  if (seller.source !== "vet402") {
    return { mode: "skip", reason: "not ALLOW", day };
  }
  const quote = await quoteCheapestSeller(seller, fetchImpl);
  const units = parseUsdcUnits(quote.accept.maxAmountRequired);
  if (quote.accept.payTo.toLowerCase() !== seller.payTo.toLowerCase()) {
    throw new Error(
      `refused: 402 payTo ${quote.accept.payTo} differs from the payTo vet402 vouched for (${seller.payTo})`,
    );
  }
  const store = params.intentStore ?? new FileIntentStore(DAILY_BUY_INTENT_DIR);
  assertDailyBuyBudget(units, dailyBuySpentUnits() + unloggedIntentUnits(store));
  if (!params.live) {
    return { mode: "dry", day, sellerUrl: quote.sellerUrl, units };
  }
  if (!params.payerPrivateKey) {
    throw new Error("missing operator key (VETGATE_ORACLE_SIGNER_PK or .secrets/mainnet-admin.key)");
  }
  const payer = privateKeyToAccount(params.payerPrivateKey).address;
  const intentKey = computeIntentKey({ day, payer });
  const unlock = store instanceof FileIntentStore ? store.lock() : () => {};
  try {
    return await guardedDailyBuy({ ...params, payerPrivateKey: params.payerPrivateKey }, {
      store,
      intentKey,
      day,
      seller,
      quote,
      units,
      fetchImpl,
      evidenceDir,
      recordRun,
    });
  } finally {
    unlock();
  }
}

/** Units of paid or maybe-paid intents that have no MAINNET_RUN.md row yet (counted against the total cap). */
export function unloggedIntentUnits(store: IntentStore): bigint {
  return store
    .list()
    .filter((r) => !r.logged && r.status !== "expired")
    .reduce((sum, r) => sum + BigInt(r.units), 0n);
}

async function guardedDailyBuy(
  params: { payerPrivateKey: `0x${string}`; readAuthorizationState?: AuthorizationStateReader; now?: Date },
  ctx: {
    store: IntentStore;
    intentKey: string;
    day: string;
    seller: Awaited<ReturnType<typeof resolveMainnetSellerPayTo>>;
    quote: SelectedX402Quote;
    units: bigint;
    fetchImpl: typeof fetch;
    evidenceDir: string;
    recordRun: boolean;
  },
): Promise<DailyBuyResult> {
  const { store, intentKey, day, seller, quote, units, fetchImpl, evidenceDir, recordRun } = ctx;
  const decision = await decideBeforeSigning({
    store,
    intentKey,
    readAuthorizationState: params.readAuthorizationState ?? createAuthorizationStateReader(CELO_MAINNET_RPC),
    nowSec: Math.floor((params.now ?? new Date()).getTime() / 1000),
  });
  if (decision.action === "stop") {
    const rec = decision.record;
    if (decision.reason === "already_paid") {
      // The chain says it was paid. Settle the record so it stops blocking, and log it if the tx is known.
      const settled = { ...rec, status: "settled" as const, settledAt: rec.settledAt ?? new Date().toISOString() };
      if (recordRun && rec.txHash && !rec.logged) {
        appendTxRow("daily_buy", rec.txHash, `x402 recovered after retry utc=${day} units=${rec.units} intent=${rec.intentKey}`);
        settled.logged = true;
      }
      store.put(settled);
    }
    return { mode: "stopped", day, reason: decision.reason, intentKey: rec.intentKey, txHash: rec.txHash };
  }
  const paid = await purchaseWithQuote({
    payerPrivateKey: params.payerPrivateKey,
    quote,
    fetchImpl,
    guard: { store, intentKey },
  });
  mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = join(evidenceDir, `${day}.json`);
  let parsed: unknown = paid.body;
  try {
    parsed = JSON.parse(paid.body);
  } catch {
    // keep the raw text
  }
  writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        utcDay: day,
        sellerUrl: quote.sellerUrl,
        request: { method: quote.httpRequest.method, url: quote.httpRequest.url, body: quote.httpRequest.body ?? null },
        vet402Verdict: "ALLOW",
        payTo: quote.accept.payTo,
        units: units.toString(),
        settlementTx: paid.txHash,
        httpStatus: paid.status,
        bodyKeccak256: paid.responseHash,
        response: parsed,
      },
      null,
      2,
    )}\n`,
  );
  let bundle: BundleReceipt | undefined;
  let bundlePath: string | undefined;
  if (seller.receipt) {
    try {
      const paymentProof = await fetchPaymentProof({ network: CELO_MAINNET_CAIP2, transaction: paid.txHash, fetchImpl });
      if (!paymentProof.found || paymentProof.status !== "confirmed") {
        throw new Error(`payment not confirmed yet (${paymentProof.status})`);
      }
      bundle = await buildBundleReceipt({
        presign: seller.receipt,
        paymentProof,
        delivery: deliveryClaimFromBody({
          status: paid.status,
          contentType: paid.contentType,
          body: paid.body,
          receivedAt: paid.receivedAt,
        }),
        agent: privateKeyToAccount(params.payerPrivateKey),
      });
      bundlePath = join(evidenceDir, `${day}.bundle.json`);
      writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
    } catch (err) {
      // The payment already happened; a missing bundle must not hide it. Say so and keep the tx row.
      console.error(`daily_buy: bundle receipt not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (recordRun) {
    appendTxRow(
      "daily_buy",
      paid.txHash,
      `x402 ${quote.sellerUrl} after vet402 ALLOW utc=${day} units=${units} bodyKeccak256=${paid.responseHash} evidence=evidence/daily-buy/${day}.json`,
    );
    const rec = store.get(intentKey);
    if (rec) store.put({ ...rec, logged: true });
  }
  return {
    mode: "live",
    day,
    sellerUrl: quote.sellerUrl,
    units,
    txHash: paid.txHash,
    responseHash: paid.responseHash,
    evidencePath,
    bundlePath,
    bundle,
  };
}

export function syncBuyOnceNetworkEnv(): void {
  process.env.VETGATE_CELO_NETWORK =
    process.env.VETGATE_CELO_NETWORK ?? process.env.VETGATE_NETWORK ?? "mainnet";
  resolveCeloRuntime();
}