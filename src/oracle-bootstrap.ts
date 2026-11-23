import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Express } from "express";
import { createApp } from "./app.js";
import { resolveCeloRuntime } from "./chain.js";

export function loadOracleKey(): `0x${string}` | undefined {
  if (process.env.VETGATE_ORACLE_SIGNER_PK) {
    return process.env.VETGATE_ORACLE_SIGNER_PK as `0x${string}`;
  }
  const runtime = resolveCeloRuntime();
  const secretName = runtime.network === "mainnet" ? "mainnet-admin.key" : "testnet.key";
  const file = join(process.cwd(), ".secrets", secretName);
  if (existsSync(file)) {
    return readFileSync(file, "utf8").trim() as `0x${string}`;
  }
  return undefined;
}

export function buildOracleApp(): Express {
  const celo = resolveCeloRuntime();
  const oraclePk = loadOracleKey();
  if (!oraclePk) {
    throw new Error(
      `Missing oracle key: set VETGATE_ORACLE_SIGNER_PK or create .secrets/${celo.network === "mainnet" ? "mainnet-admin.key" : "testnet.key"}`,
    );
  }

  const payTo = (process.env.VETGATE_PAYTO_ADDRESS ??
    "0x0000000000000000000000000000000000000001") as `0x${string}`;
  const payGuard = (process.env.VETGATE_PAY_GUARD_ADDRESS ??
    "0x0000000000000000000000000000000000000001") as `0x${string}`;

  return createApp({
    payTo,
    payGuardAddress: payGuard,
    oraclePrivateKey: oraclePk,
    teamWalletsCsv: process.env.VETGATE_TEAM_WALLETS,
    x402ApiKey: process.env.X402_API_KEY,
    facilitatorUrl: process.env.CELO_FACILITATOR_URL,
    enableX402: Boolean(process.env.X402_API_KEY),
  });
}