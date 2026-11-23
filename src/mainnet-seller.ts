import {
  CELO_MAINNET_CHAIN_ID,
  MAINNET_ADMIN_ADDRESS,
  MAINNET_CONTROLLED_SELLER_PAYTO,
  MAINNET_CONTROLLED_SELLER_URL,
} from "./chain.js";
import { fetchVet402Check, isVet402Allow, type Vet402CheckDocument } from "./vet402.js";

export type ResolvedMainnetSeller = {
  payTo: `0x${string}`;
  sellerUrl: string;
  source: "vet402" | "controlled";
};

function payToFromVet402(doc: Vet402CheckDocument): `0x${string}` | undefined {
  const list = doc.verified_pay_to_by_network;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && typeof entry === "object") {
        const rec = entry as Record<string, unknown>;
        const net = String(rec.network ?? rec.chain ?? rec.chainId ?? "").toLowerCase();
        const payTo = String(rec.payTo ?? rec.pay_to ?? "");
        if (
          payTo.startsWith("0x") &&
          (net.includes("42220") || net.includes("celo") || net === "eip155:42220")
        ) {
          return payTo as `0x${string}`;
        }
      }
    }
  }
  const delivery = doc.delivery;
  if (delivery && typeof delivery === "object") {
    const d = delivery as Record<string, unknown>;
    const payTo = String(d.payTo ?? d.pay_to ?? "");
    if (payTo.startsWith("0x")) return payTo as `0x${string}`;
  }
  return undefined;
}

function defaultSellerUrlCandidates(): string[] {
  const fromEnv = (process.env.VETGATE_MAINNET_SELLER_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("https://"));
  return fromEnv;
}

/**
 * Pick a demo seller payTo: vet402 ALLOW on Celo, else team-controlled address (not admin).
 */
export async function resolveMainnetSellerPayTo(
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedMainnetSeller> {
  for (const sellerUrl of defaultSellerUrlCandidates()) {
    const doc = await fetchVet402Check(sellerUrl, fetchImpl);
    if (!isVet402Allow(doc)) continue;
    const payTo = payToFromVet402(doc);
    if (!payTo || payTo.toLowerCase() === MAINNET_ADMIN_ADDRESS.toLowerCase()) continue;
    return { payTo, sellerUrl, source: "vet402" };
  }
  return {
    payTo: MAINNET_CONTROLLED_SELLER_PAYTO,
    sellerUrl: MAINNET_CONTROLLED_SELLER_URL,
    source: "controlled",
  };
}

export function assertSellerNotAdmin(payTo: `0x${string}`): void {
  if (payTo.toLowerCase() === MAINNET_ADMIN_ADDRESS.toLowerCase()) {
    throw new Error("seller payTo must not be the admin wallet");
  }
}

export const MAINNET_DEMO_PAYMENT_UNITS = 10_000n;

export function assertMainnetDemoAmount(amount: bigint): void {
  if (amount > MAINNET_DEMO_PAYMENT_UNITS) {
    throw new Error(
      `mainnet demo payment refused: ${amount} units (max ${MAINNET_DEMO_PAYMENT_UNITS} = 0.01 USDC)`,
    );
  }
}

export const MAINNET_CHAIN_ID = CELO_MAINNET_CHAIN_ID;