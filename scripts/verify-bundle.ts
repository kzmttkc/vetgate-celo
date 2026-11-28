#!/usr/bin/env npx tsx
/**
 * Third-party check of a pay-guard.bundle.v1 file, with no key:
 *   npx tsx scripts/verify-bundle.ts evidence/daily-buy/<UTC day>.bundle.json
 * Checks the agent's EIP-191 signature, vet402's verdict signature (POST /api/v1/receipts/verify)
 * and re-reads the payment on Celo (POST /api/v1/payment-proof).
 */
import { readFileSync } from "node:fs";
import { verifyBundleReceipt, type BundleReceipt } from "../src/pay-guard.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: verify-bundle.ts <bundle.json>");
  process.exit(2);
}
const bundle = JSON.parse(readFileSync(path, "utf8")) as BundleReceipt;
const result = await verifyBundleReceipt(bundle);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
