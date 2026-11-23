#!/usr/bin/env npx tsx
/**
 * Live VetGate /v1/permit as Self agent 194 (operator key). Read-only for chain.
 */
import { SelfAgent } from "@selfxyz/agent-sdk";

import { loadOracleKey } from "../src/oracle-bootstrap.js";
import { resolveCeloRuntime } from "../src/chain.js";

const DEFAULT_VETGATE_URL = "https://vetgate-celo-orcin.vercel.app";

const PAY_TO = "0x20faaca5f980e29639a0fcc6dca6988e18ed333b" as const;
const BUYER = "0xCDb0FF6e6Dfc33F9d75288772c8EfFaa13df9941" as const;
const SELLER_URL = "https://gateway.usebuy.ai/v1/social/tiktok/profile";

async function main(): Promise<void> {
  process.env.VETGATE_CELO_NETWORK =
    process.env.VETGATE_CELO_NETWORK ?? process.env.VETGATE_NETWORK ?? "mainnet";

  const pk = loadOracleKey();
  if (!pk) {
    throw new Error("missing oracle key (VETGATE_ORACLE_SIGNER_PK or .secrets/mainnet-admin.key)");
  }

  const celo = resolveCeloRuntime();
  const vetgateUrl = (process.env.VETGATE_URL ?? DEFAULT_VETGATE_URL).replace(/\/$/, "");

  const selfAgent = new SelfAgent({
    privateKey: pk,
    network: celo.selfNetwork,
    rpcUrl: celo.rpc,
  });

  const url = new URL(`${vetgateUrl}/v1/permit`);
  url.searchParams.set("payTo", PAY_TO);
  url.searchParams.set("buyer", BUYER);
  url.searchParams.set("sellerUrl", SELLER_URL);
  url.searchParams.set("maxAmount", "1000000");

  const resp = await selfAgent.fetch(url.toString());
  const status = resp.status;
  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    json = { error: "non_json_body", text: await resp.text() };
  }

  console.log(JSON.stringify({ status, body: json }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});