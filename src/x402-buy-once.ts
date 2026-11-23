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
import { appendTxRow, assertStepNotDone } from "./mainnet-run-log.js";
import {
  BUILTIN_CANDIDATE_SELLER_URLS,
  resolveMainnetSellerPayTo,
  type ResolvedMainnetSeller,
} from "./mainnet-seller.js";

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

export type SelectedX402Quote = {
  sellerUrl: string;
  requestUrl: string;
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
  requestUrl: string;
  payerPrivateKey: `0x${string}`;
  fetchImpl?: typeof fetch;
}): Promise<PaymentPayload> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const account = privateKeyToAccount(params.payerPrivateKey);
  const coreClient = createBuyOnceX402Client(account);
  const httpClient = new x402HTTPClient(coreClient);

  const response = await fetchImpl(params.requestUrl, { method: "GET" });
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
  requestUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; paymentRequired: X402V1PaymentRequired }> {
  const resp = await fetchImpl(requestUrl, { method: "GET", redirect: "follow" });
  const text = await resp.text();
  let body: X402V1PaymentRequired;
  try {
    body = JSON.parse(text) as X402V1PaymentRequired;
  } catch {
    throw new Error(`expected JSON 402 body from ${requestUrl}, got status ${resp.status}`);
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
  const requestUrl = probeUrlForSeller(seller.sellerUrl);
  const { status, paymentRequired } = await fetchPaymentRequired(requestUrl, fetchImpl);
  if (status !== 402) {
    throw new Error(`expected HTTP 402 from seller, got ${status}`);
  }
  const accept = selectCeloMainnetAccept(paymentRequired, CELO_MAINNET_USDC);
  return { sellerUrl: seller.sellerUrl, requestUrl, accept, paymentRequired };
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
  paymentPayloadV2: PaymentPayload;
};

export async function runBuyOnceDry(params: {
  payer: `0x${string}`;
  payerPrivateKey: `0x${string}`;
  fetchImpl?: typeof fetch;
}): Promise<BuyOnceDryResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const quote = await discoverCheapestUsefulQuote(fetchImpl);
  const eip3009 = buildEip3009SignPreview({ accept: quote.accept, payer: params.payer });
  const paymentPayloadV2 = await buildBuyOnceV2PaymentPayload({
    requestUrl: quote.requestUrl,
    payerPrivateKey: params.payerPrivateKey,
    fetchImpl,
  });
  return { mode: "dry", quote, eip3009, paymentPayloadV2 };
}

export async function runBuyOnceLive(params: {
  payerPrivateKey: `0x${string}`;
  fetchImpl?: typeof fetch;
}): Promise<{ responseHash: Hex; txHash: `0x${string}`; quote: SelectedX402Quote }> {
  assertStepNotDone("buy_purchase");
  const fetchImpl = params.fetchImpl ?? fetch;
  const account = privateKeyToAccount(params.payerPrivateKey);
  const quote = await discoverCheapestUsefulQuote(fetchImpl);

  const coreClient = createBuyOnceX402Client(account);
  const httpClient = new x402HTTPClient(coreClient);

  let response = await fetchImpl(quote.requestUrl, { method: "GET" });
  if (response.status !== 402) {
    throw new Error(`expected 402 before payment, got ${response.status}`);
  }

  const bodyText = await response.text();
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name) => response.headers.get(name),
    JSON.parse(bodyText),
  );

  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const payHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  response = await fetchImpl(quote.requestUrl, {
    method: "GET",
    headers: payHeaders,
  });

  const paidBody = await response.text();
  const responseHash = keccak256(stringToHex(paidBody));

  const settle = httpClient.getPaymentSettleResponse((name) => response.headers.get(name));
  const txHash = (settle?.transaction ?? "0x0") as `0x${string}`;
  if (!txHash || txHash === "0x0") {
    throw new Error("payment completed but settlement transaction hash missing");
  }

  appendTxRow(
    "buy_purchase",
    txHash,
    `x402 usebuy bodySha256=${responseHash} units=${quote.accept.maxAmountRequired}`,
  );

  return { responseHash, txHash, quote };
}

export function syncBuyOnceNetworkEnv(): void {
  process.env.VETGATE_CELO_NETWORK =
    process.env.VETGATE_CELO_NETWORK ?? process.env.VETGATE_NETWORK ?? "mainnet";
  resolveCeloRuntime();
}