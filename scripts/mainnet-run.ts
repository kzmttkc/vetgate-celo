#!/usr/bin/env npx tsx
/**
 * Stepwise mainnet executor. Requires funding + `--i-understand-mainnet` (except `--dry`).
 * Refuses any single USDC transfer above 1 USDC (1_000_000 units).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveAttributionCode } from "../src/chain.js";
import { defineMainnetRunSteps, type MainnetRunStepId } from "../src/mainnet-runbook.js";
import {
  assertMainnetChain,
  runMainnetStep,
  syncNetworkEnvFromAlias,
} from "../src/mainnet-executor.js";

type CliArgs = {
  understand: boolean;
  dry: boolean;
  daily: boolean;
  allowTestnet: boolean;
  step?: number;
};

function parseArgs(argv: string[]): CliArgs {
  return {
    understand: argv.includes("--i-understand-mainnet"),
    dry: argv.includes("--dry"),
    daily: argv.includes("--daily"),
    allowTestnet: argv.includes("--testnet"),
    step:
      (() => {
        const stepIdx = argv.indexOf("--step");
        return stepIdx >= 0 && argv[stepIdx + 1] ? Number(argv[stepIdx + 1]) : undefined;
      })(),
  };
}

function readSecretKey(relPath: string): `0x${string}` {
  const path = join(process.cwd(), relPath);
  if (!existsSync(path)) {
    throw new Error(`missing key file: ${relPath} (set env override or create under .secrets/)`);
  }
  return readFileSync(path, "utf8").trim() as `0x${string}`;
}

function loadOracleKey(): `0x${string}` {
  if (process.env.VETGATE_ORACLE_SIGNER_PK) {
    return process.env.VETGATE_ORACLE_SIGNER_PK as `0x${string}`;
  }
  return readSecretKey(".secrets/mainnet-admin.key");
}

function loadAltanaKey(): `0x${string}` {
  if (process.env.VETGATE_ALTANA_ADMIN_PK) {
    return process.env.VETGATE_ALTANA_ADMIN_PK as `0x${string}`;
  }
  return readSecretKey(".secrets/altana-admin.key");
}

function loadSelfAgentKey(oraclePk: `0x${string}`): `0x${string}` {
  const fromEnv = process.env.VETGATE_SELF_AGENT_PK;
  if (fromEnv) return fromEnv as `0x${string}`;
  return oraclePk;
}

async function main(): Promise<void> {
  syncNetworkEnvFromAlias();
  const args = parseArgs(process.argv.slice(2));

  if (!args.dry && !args.understand) {
    console.error("Refusing: pass --i-understand-mainnet to send mainnet transactions (or --dry).");
    process.exit(1);
  }
  if (!args.step || args.step < 1 || args.step > 7) {
    console.error("Pass --step N where N is 1..7 (see mainnet-plan.ts).");
    process.exit(1);
  }

  const payGuard = (process.env.VETGATE_PAY_GUARD_ADDRESS ??
    "0x00000000000000000000000000000000000000aa") as `0x${string}`;
  const steps = defineMainnetRunSteps(payGuard);
  const selected = steps.find((s) => s.order === args.step);
  if (!selected) throw new Error("step not found");

  assertMainnetChain(args.allowTestnet);

  console.log(
    `Executing step ${args.step}: ${selected.id} (tag ${resolveAttributionCode()})` +
      (args.dry ? " [DRY]" : ""),
  );

  const oraclePk = loadOracleKey();
  const altanaPk = loadAltanaKey();
  const vetgateUrl = process.env.VETGATE_URL ?? "http://localhost:3001";
  const selfAgentPk = loadSelfAgentKey(oraclePk);

  process.env.VETGATE_CELO_NETWORK = process.env.VETGATE_CELO_NETWORK ?? "mainnet";
  process.env.VETGATE_ALTANA_MOCK = "0";

  await runMainnetStep(selected.id as MainnetRunStepId, {
    dry: args.dry,
    daily: args.daily,
    allowTestnet: args.allowTestnet,
    payGuard,
    oraclePk,
    altanaPk,
    vetgateUrl,
    selfAgentPk,
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});