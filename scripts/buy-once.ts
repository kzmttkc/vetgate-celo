#!/usr/bin/env npx tsx
/**
 * One x402 purchase on Celo mainnet. Default is --dry (402 terms + EIP-3009 preview only).
 * Live broadcast requires --i-understand-mainnet (operator key pays via EIP-3009).
 */
import { privateKeyToAccount } from "viem/accounts";

import { loadOracleKey } from "../src/oracle-bootstrap.js";
import { runBuyOnceDry, runBuyOnceLive, syncBuyOnceNetworkEnv } from "../src/x402-buy-once.js";

function parseDry(): boolean {
  if (process.argv.includes("--i-understand-mainnet")) return false;
  return true;
}

async function main(): Promise<void> {
  syncBuyOnceNetworkEnv();
  const dry = parseDry();

  const pk = loadOracleKey();
  if (!pk) {
    throw new Error("missing operator key (VETGATE_ORACLE_SIGNER_PK or .secrets/mainnet-admin.key)");
  }
  const payer = privateKeyToAccount(pk).address;

  if (dry) {
    const result = await runBuyOnceDry({ payer });
    console.log(
      JSON.stringify(
        {
          mode: result.mode,
          sellerUrl: result.quote.sellerUrl,
          requestUrl: result.quote.requestUrl,
          httpStatus: 402,
          paymentRequired: result.quote.paymentRequired,
          selectedAccept: result.quote.accept,
          eip3009SignPreview: result.eip3009,
        },
        null,
        2,
      ),
    );
    return;
  }

  const live = await runBuyOnceLive({ payerPrivateKey: pk });
  console.log(
    JSON.stringify(
      {
        mode: "live",
        txHash: live.txHash,
        responseHash: live.responseHash,
        sellerUrl: live.quote.sellerUrl,
        accept: live.quote.accept,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});