#!/usr/bin/env npx tsx
/**
 * Idempotent daily operator payWithPermit (MAINNET_RUN.md UTC day).
 * vet402 ALLOW + locally minted permit from oracle key, no Altana re-grant.
 */
import { spawnSync } from "node:child_process";

const dry = process.argv.includes("--dry");
const extra = dry ? ["--dry"] : ["--i-understand-mainnet"];

const result = spawnSync(
  process.execPath,
  [
    "--import",
    "./scripts/register-relay-attribution.mjs",
    "./node_modules/tsx/dist/cli.mjs",
    "scripts/mainnet-run.ts",
    "--step",
    "7",
    "--daily",
    ...extra,
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

process.exit(result.status ?? 1);