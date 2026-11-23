#!/usr/bin/env npx tsx
/**
 * Idempotent daily small-use loop (MAINNET_RUN.md UTC day).
 * Intended for launchd/cron — owner reviews before enabling live sends.
 */
import { spawnSync } from "node:child_process";

const dry = process.argv.includes("--dry");
const extra = dry ? ["--dry"] : ["--i-understand-mainnet"];

const result = spawnSync(
  "npx",
  ["tsx", "scripts/mainnet-run.ts", "--step", "7", "--daily", ...extra],
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