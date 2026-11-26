#!/usr/bin/env npx tsx
/**
 * Once per UTC day: vet402 check on the seller, then one x402 purchase on buy (gateway.usebuy.ai)
 * through Celo's facilitator, only on ALLOW. Default is --dry (quote only, no payment).
 * Live needs --i-understand-mainnet. Caps: 5000 units per call, 100000 units in total.
 */
import { loadOracleKey } from "../src/oracle-bootstrap.js";
import { runDailyBuy, syncBuyOnceNetworkEnv } from "../src/x402-buy-once.js";

async function main(): Promise<void> {
  syncBuyOnceNetworkEnv();
  const live = process.argv.includes("--i-understand-mainnet");
  const result = await runDailyBuy({ live, payerPrivateKey: live ? (loadOracleKey() ?? undefined) : undefined });
  if (result.mode === "skip") {
    console.log(`daily_buy: skip — ${result.reason} utc=${result.day}`);
    return;
  }
  console.log(
    JSON.stringify(
      { ...result, units: result.units.toString() },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
