#!/usr/bin/env npx tsx
/**
 * Prints ordered mainnet transactions (no broadcast). Safe to run unfunded.
 */
import { createPublicClient, formatEther, http } from "viem";
import { celo } from "viem/chains";

import { calldataIncludesAttribution } from "../src/attribution.js";
import {
  CELO_MAINNET_USDC,
  MAINNET_ADMIN_ADDRESS,
  PLACEHOLDER_ATTRIBUTION_TAG,
  resolveAttributionCode,
} from "../src/chain.js";
import {
  defineMainnetRunSteps,
  type MainnetRunStep,
} from "../src/mainnet-runbook.js";

const payGuardPlaceholder = (process.env.VETGATE_PAY_GUARD_ADDRESS ??
  "0x00000000000000000000000000000000000000aa") as `0x${string}`;

async function estimateGas(
  client: ReturnType<typeof createPublicClient>,
  step: MainnetRunStep,
): Promise<bigint | undefined> {
  if (!step.sampleTaggedCalldata) return undefined;
  try {
    return await client.estimateGas({
      account: MAINNET_ADMIN_ADDRESS,
      to: step.id === "deploy_pay_guard" ? undefined : payGuardPlaceholder,
      data: step.sampleTaggedCalldata,
    });
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const client = createPublicClient({
    chain: celo,
    transport: http(process.env.CELO_RPC_URL ?? "https://forno.celo.org"),
  });

  const [adminBal, usdcBal] = await Promise.all([
    client.getBalance({ address: MAINNET_ADMIN_ADDRESS }).catch(() => 0n),
    client
      .readContract({
        address: CELO_MAINNET_USDC,
        abi: [
          {
            name: "balanceOf",
            type: "function",
            stateMutability: "view",
            inputs: [{ name: "account", type: "address" }],
            outputs: [{ name: "", type: "uint256" }],
          },
        ],
        functionName: "balanceOf",
        args: [MAINNET_ADMIN_ADDRESS],
      })
      .catch(() => 0n),
  ]);

  const steps = defineMainnetRunSteps(payGuardPlaceholder);
  let totalGas = 0n;
  let totalUsdcPlan = 0n;

  console.log("=== VetGate Celo MAINNET plan (42220) — DRY RUN, no broadcast ===\n");
  console.log(`Attribution tag: ${resolveAttributionCode()}`);
  console.log(`Admin wallet:    ${MAINNET_ADMIN_ADDRESS}`);
  console.log(`On-chain now:    ${formatEther(adminBal)} CELO, ${usdcBal} USDC (6dp units)\n`);

  for (const step of steps) {
    const gas = await estimateGas(client, step);
    if (gas !== undefined) step.gasEstimateWei = gas;
    if (gas) totalGas += gas;
    totalUsdcPlan += step.usdcDelta;

    const suffixOk =
      step.sampleTaggedCalldata &&
      calldataIncludesAttribution(step.sampleTaggedCalldata, PLACEHOLDER_ATTRIBUTION_TAG);
    console.log(
      `${step.order}. [${step.id}] ${step.title}`,
    );
    console.log(`   ${step.description}`);
    if (step.sampleTaggedCalldata) {
      console.log(
        `   tagged calldata: ${step.sampleTaggedCalldata.slice(0, 42)}… (${step.sampleTaggedCalldata.length / 2 - 1} bytes) suffixOK=${suffixOk}`,
      );
    }
    if (gas !== undefined) {
      console.log(`   eth_estimateGas: ${gas} wei (~${formatEther(gas)} CELO at 1:1 gas price)`);
    } else {
      console.log(`   eth_estimateGas: (skipped — relay/multi-tx or simulation reverted)`);
    }
    if (step.usdcDelta > 0n) {
      console.log(`   USDC moved (plan): ${step.usdcDelta} units`);
    }
    console.log("");
  }

  const dailyDays = Number(process.env.VETGATE_DAILY_LOOP_DAYS ?? "14");
  const dailyStep = steps.find((s) => s.id === "daily_small_use");
  const dailyUsdc = dailyStep ? dailyStep.usdcDelta * BigInt(dailyDays) : 0n;
  totalUsdcPlan += dailyUsdc;

  console.log("=== Totals (estimate) ===");
  console.log(`Gas steps summed:     ${totalGas} wei (~${formatEther(totalGas)} CELO — undercounts Altana relay bundles)`);
  console.log(`USDC (one-shot demo): ${totalUsdcPlan - dailyUsdc} units`);
  console.log(`USDC (daily x${dailyDays}): ${dailyUsdc} units`);
  console.log(`USDC grand total:     ${totalUsdcPlan} units (${Number(totalUsdcPlan) / 1e6} USDC)`);
  console.log(
    `\nRecommended fund before run: ~${formatEther(totalGas + 500_000_000_000_000_000n)} CELO buffer + ${Number(totalUsdcPlan) / 1e6 + 2} USDC`,
  );
  console.log(
    "\nRun: npx tsx scripts/mainnet-run.ts --i-understand-mainnet --step 1",
  );
  console.log(`\nTag constant in repo: ${PLACEHOLDER_ATTRIBUTION_TAG}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});