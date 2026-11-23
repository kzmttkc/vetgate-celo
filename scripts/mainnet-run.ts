#!/usr/bin/env npx tsx
/**
 * Stepwise mainnet executor. Requires funding + `--i-understand-mainnet`.
 * Refuses any single USDC transfer above 1 USDC (1_000_000 units).
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildErc8004RegisterCall, createClient, CELO, signerFromPrivateKey } from "@altananetwork/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";
import { celo } from "viem/chains";

import { appendAttributionSuffix } from "../src/attribution.js";
import {
  CELO_MAINNET_USDC,
  MAINNET_ADMIN_ADDRESS,
  resolveAttributionCode,
} from "../src/chain.js";
import {
  assertUsdcWithinCap,
  buildDeployPayGuardCalldata,
  defineMainnetRunSteps,
  MAINNET_AGENT_URI,
  type MainnetRunStepId,
} from "../src/mainnet-runbook.js";
import { runGuardedProcurement } from "../src/agent-buyer.js";

const RUN_LOG = join(process.cwd(), "MAINNET_RUN.md");

function parseArgs(argv: string[]): { understand: boolean; step?: number } {
  const understand = argv.includes("--i-understand-mainnet");
  const stepIdx = argv.indexOf("--step");
  const step =
    stepIdx >= 0 && argv[stepIdx + 1] ? Number(argv[stepIdx + 1]) : undefined;
  return { understand, step };
}

function loadAdminKey(): `0x${string}` {
  const fromEnv = process.env.VETGATE_ORACLE_SIGNER_PK;
  if (fromEnv) return fromEnv as `0x${string}`;
  const path = join(process.cwd(), ".secrets", "mainnet-admin.key");
  return readFileSync(path, "utf8").trim() as `0x${string}`;
}

function recordTx(step: MainnetRunStepId, hash: string, note: string): void {
  const line = `| ${step} | \`${hash}\` | ${note} | ${new Date().toISOString()} |\n`;
  if (!readFileSync(RUN_LOG, "utf8").includes("| Tx hash |")) {
    writeFileSync(
      RUN_LOG,
      `# Celo mainnet run log (42220)\n\n| Step | Tx hash | Note | UTC |\n|---|---|---|---|\n${line}`,
    );
  } else {
    appendFileSync(RUN_LOG, line);
  }
  console.log(`Recorded ${hash} → MAINNET_RUN.md`);
}

async function runStep(
  stepId: MainnetRunStepId,
  adminPk: `0x${string}`,
  payGuard: `0x${string}`,
): Promise<void> {
  const adminAccount = privateKeyToAccount(adminPk);
  const walletClient = createWalletClient({
    account: adminAccount,
    chain: celo,
    transport: http(process.env.CELO_RPC_URL ?? "https://forno.celo.org"),
  });

  process.env.VETGATE_CELO_NETWORK = "mainnet";
  process.env.VETGATE_ALTANA_MOCK = "0";

  switch (stepId) {
    case "deploy_pay_guard": {
      const data = buildDeployPayGuardCalldata(adminAccount.address);
      const hash = await walletClient.sendTransaction({ data, value: 0n });
      recordTx(stepId, hash, "PayGuard CREATE + ERC-8021 suffix");
      console.log(`Set VETGATE_PAY_GUARD_ADDRESS after receipt confirms contract address.`);
      break;
    }
    case "register_erc8004_seller": {
      const client = createClient({ chains: [CELO], agentIdentity: false });
      const admin = signerFromPrivateKey(adminPk);
      const wallet = await client.createWallet({ signer: admin });
      const call = buildErc8004RegisterCall(42220, MAINNET_AGENT_URI, [
        {
          metadataKey: "x402Support",
          metadataValue: "0x" + Buffer.from("true", "utf8").toString("hex"),
        },
      ]);
      const result = await client.execute({
        wallet,
        signer: admin,
        chainId: 42220,
        calls: [{ to: call.to, data: appendAttributionSuffix(call.data) }],
        feeToken: CELO_MAINNET_USDC,
      });
      if (result.transactionHash) {
        recordTx(stepId, result.transactionHash, `ERC-8004 register (${result.status})`);
      }
      break;
    }
    case "altana_wallet_and_session":
    case "demo_allow_payment":
    case "demo_block_revert":
    case "revoke_session": {
      assertUsdcWithinCap(10_000n, stepId);
      const sessionPk = (process.env.VETGATE_SESSION_PK ??
        `0x${"44".repeat(32)}`) as `0x${string}`;
      const selfPk = (process.env.VETGATE_SELF_AGENT_PK ?? adminPk) as `0x${string}`;
      const vetgateUrl = process.env.VETGATE_URL ?? "http://localhost:3001";
      if (stepId === "demo_allow_payment") {
        const res = await runGuardedProcurement({
          adminPrivateKey: adminPk,
          sessionPrivateKey: sessionPk,
          selfAgentPrivateKey: selfPk,
          payGuardAddress: payGuard,
          targetPayTo: MAINNET_ADMIN_ADDRESS,
          amountUnits: 10_000n,
          vetgateUrl,
          sellerUrl: "https://example.com/allow",
        });
        if (res.status === "paid_under_guard") {
          recordTx(stepId, res.execTxHash, "ALLOW payWithPermit");
        }
      } else if (stepId === "demo_block_revert") {
        const res = await runGuardedProcurement({
          adminPrivateKey: adminPk,
          sessionPrivateKey: sessionPk,
          selfAgentPrivateKey: selfPk,
          payGuardAddress: payGuard,
          targetPayTo: MAINNET_ADMIN_ADDRESS,
          amountUnits: 10_000n,
          vetgateUrl,
          sellerUrl: "https://example.com/block",
          mockOracle: { verdict: "BLOCK", permit: null },
        });
        recordTx(stepId, "0x0", `blocked: ${res.status}`);
      } else {
        console.log(
          `${stepId}: run via Altana SDK (grantSession / revokeSession). See agent-buyer.ts; ensure wallet funded.`,
        );
      }
      break;
    }
    case "daily_small_use": {
      assertUsdcWithinCap(10_000n, stepId);
      console.log(
        "Daily loop: invoke buy CLI or runGuardedProcurement with amount 10000; cron not started in this script.",
      );
      break;
    }
    default:
      throw new Error(`Unknown step ${stepId satisfies never}`);
  }
}

async function main(): Promise<void> {
  const { understand, step } = parseArgs(process.argv.slice(2));
  if (!understand) {
    console.error("Refusing: pass --i-understand-mainnet to send mainnet transactions.");
    process.exit(1);
  }
  if (!step || step < 1 || step > 7) {
    console.error("Pass --step N where N is 1..7 (see mainnet-plan.ts).");
    process.exit(1);
  }

  const payGuard = (process.env.VETGATE_PAY_GUARD_ADDRESS ??
    "0x00000000000000000000000000000000000000aa") as `0x${string}`;
  const steps = defineMainnetRunSteps(payGuard);
  const selected = steps.find((s) => s.order === step);
  if (!selected) throw new Error("step not found");

  console.log(`Executing step ${step}: ${selected.id} (tag ${resolveAttributionCode()})`);
  const adminPk = loadAdminKey();
  await runStep(selected.id, adminPk, payGuard);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});