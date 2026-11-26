#!/usr/bin/env npx tsx
/**
 * Idempotent daily run (MAINNET_RUN.md UTC day):
 * 1. operator payWithPermit through PayGuard (vet402 ALLOW + locally minted permit, tagged tx)
 * 2. one x402 purchase on buy through Celo's facilitator, only on vet402 ALLOW (scripts/daily-buy.ts)
 */
import { spawnSync } from "node:child_process";

const dry = process.argv.includes("--dry");
const extra = dry ? ["--dry"] : ["--i-understand-mainnet"];

function run(script: string, args: string[]): number {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./scripts/register-relay-attribution.mjs",
      "./node_modules/tsx/dist/cli.mjs",
      script,
      ...args,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        VETGATE_CELO_NETWORK:
          process.env.VETGATE_CELO_NETWORK ?? process.env.VETGATE_NETWORK ?? "mainnet",
      },
      stdio: "inherit",
    },
  );
  return result.status ?? 1;
}

const payStatus = run("scripts/mainnet-run.ts", ["--step", "7", "--daily", ...extra]);
const buyStatus = run("scripts/daily-buy.ts", dry ? [] : ["--i-understand-mainnet"]);
process.exit(payStatus !== 0 ? payStatus : buyStatus);