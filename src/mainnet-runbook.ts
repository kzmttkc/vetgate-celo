import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildErc8004RegisterCall } from "@altananetwork/sdk";
import {
  encodeDeployData,
  encodeFunctionData,
  parseAbi,
  type Hex,
} from "viem";

import { appendAttributionSuffix, attributionTagBytes } from "./attribution.js";
import {
  CELO_MAINNET_CHAIN_ID,
  MAINNET_ADMIN_ADDRESS,
  resolveAttributionCode,
} from "./chain.js";

const PAY_GUARD_ABI = parseAbi([
  "constructor(address _oracleSigner)",
  "function payWithPermit(address payTo, address token, uint256 amount, uint256 maxAmount, uint256 expiresAt, bytes32 nonce, uint8 verdict, bytes signature, bytes attributionTag) external",
]);

export const MAX_MAINNET_USDC_PER_TX = 1_000_000n;

/** Scoped to VetGatePayGuard.payWithPermit only (Altana session calls permission). */
export const PAY_WITH_PERMIT_CALL_SIG =
  "payWithPermit(address,address,uint256,uint256,uint256,bytes32,uint8,bytes,bytes)";

export const MAINNET_AGENT_URI =
  "https://vetgate-celo.local/agent-registration.json";

export type MainnetRunStepId =
  | "deploy_pay_guard"
  | "register_erc8004_seller"
  | "altana_wallet_and_session"
  | "demo_allow_payment"
  | "demo_block_revert"
  | "revoke_session"
  | "daily_small_use"
  | "buy_purchase";

export type MainnetRunStep = {
  id: MainnetRunStepId;
  order: number;
  title: string;
  description: string;
  /** Hex call data or deploy bytecode+args, with ERC-8021 suffix where applicable. */
  sampleTaggedCalldata?: Hex;
  /** USDC (6 decimals) moved on success — plan totals only. */
  usdcDelta: bigint;
  /** Native CELO gas estimate from eth_estimateGas when available. */
  gasEstimateWei?: bigint;
};

function loadPayGuardBytecode(): Hex {
  const artifactPath = join(
    process.cwd(),
    "out/VetGatePayGuard.sol/VetGatePayGuard.json",
  );
  const raw = JSON.parse(readFileSync(artifactPath, "utf8")) as {
    bytecode: { object: string };
  };
  return raw.bytecode.object as Hex;
}

export function buildDeployPayGuardCalldata(oracleSigner: `0x${string}`): Hex {
  const bytecode = loadPayGuardBytecode();
  const init = encodeDeployData({
    abi: PAY_GUARD_ABI,
    bytecode,
    args: [oracleSigner],
  });
  return appendAttributionSuffix(init);
}

export function buildRegisterErc8004Calldata(): Hex {
  const call = buildErc8004RegisterCall(CELO_MAINNET_CHAIN_ID, MAINNET_AGENT_URI, [
    {
      metadataKey: "x402Support",
      metadataValue: "0x" + Buffer.from("true", "utf8").toString("hex"),
    },
  ]);
  return appendAttributionSuffix(call.data);
}

export function buildPayWithPermitCalldata(params: {
  payGuard: `0x${string}`;
  payTo: `0x${string}`;
  token: `0x${string}`;
  amount: bigint;
  verdict: number;
}): Hex {
  const tag = resolveAttributionCode();
  const inner = encodeFunctionData({
    abi: PAY_GUARD_ABI,
    functionName: "payWithPermit",
    args: [
      params.payTo,
      params.token,
      params.amount,
      params.amount,
      BigInt(Math.floor(Date.now() / 1000) + 3600),
      `0x${"aa".repeat(32)}`,
      params.verdict,
      "0x",
      attributionTagBytes(tag),
    ],
  });
  return appendAttributionSuffix(inner);
}

export function defineMainnetRunSteps(payGuardPlaceholder: `0x${string}`): MainnetRunStep[] {
  const tag = resolveAttributionCode();
  const dailyUsdc = 10_000n;

  return [
    {
      id: "deploy_pay_guard",
      order: 1,
      title: "Deploy VetGatePayGuard",
      description: `CREATE from admin ${MAINNET_ADMIN_ADDRESS}; oracleSigner = same admin; calldata suffix ${tag}.`,
      sampleTaggedCalldata: buildDeployPayGuardCalldata(MAINNET_ADMIN_ADDRESS),
      usdcDelta: 0n,
    },
    {
      id: "register_erc8004_seller",
      order: 2,
      title: "Register ERC-8004 seller agent (oracle wallet)",
      description:
        "Admin Altana wallet or EOA calls identity registry register(agentURI) with attribution suffix (x402Support metadata in follow-up setAgentURI).",
      sampleTaggedCalldata: buildRegisterErc8004Calldata(),
      usdcDelta: 0n,
    },
    {
      id: "altana_wallet_and_session",
      order: 3,
      title: "Create Altana buyer wallet + grantSession",
      description:
        "Altana admin (0xCDb0…, nonce 0) createWallet + grantSession; oracle 0x970b… funds USDC; calls=[PayGuard], spend cap 1 USDC/day.",
      usdcDelta: 0n,
    },
    {
      id: "demo_allow_payment",
      order: 4,
      title: "ALLOW payment under PayGuard",
      description: "Session execute → payWithPermit (ALLOW oracle permit); amount ≤ 0.01 USDC.",
      sampleTaggedCalldata: buildPayWithPermitCalldata({
        payGuard: payGuardPlaceholder,
        payTo: MAINNET_ADMIN_ADDRESS,
        token: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
        amount: 10_000n,
        verdict: 1,
      }),
      usdcDelta: 10_000n,
    },
    {
      id: "demo_block_revert",
      order: 5,
      title: "BLOCK attempt (expect revert)",
      description:
        "Session execute → payWithPermit with verdict≠ALLOW or bad sig; must revert on-chain; proves guard rejects non-ALLOW.",
      sampleTaggedCalldata: buildPayWithPermitCalldata({
        payGuard: payGuardPlaceholder,
        payTo: MAINNET_ADMIN_ADDRESS,
        token: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
        amount: 10_000n,
        verdict: 0,
      }),
      usdcDelta: 0n,
    },
    {
      id: "revoke_session",
      order: 6,
      title: "revokeSession",
      description: "Admin revokes buyer session; subsequent execute must fail.",
      usdcDelta: 0n,
    },
    {
      id: "daily_small_use",
      order: 7,
      title: "Daily small-use loop (10–14 days)",
      description: `Once per UTC day: vet402 ALLOW, oracle mints permit, operator EOA ${MAINNET_ADMIN_ADDRESS} sends tagged payWithPermit (${dailyUsdc} units) direct to PayGuard (no Altana session).`,
      usdcDelta: dailyUsdc,
    },
  ];
}

export function assertUsdcWithinCap(amount: bigint, context: string): void {
  if (amount > MAX_MAINNET_USDC_PER_TX) {
    throw new Error(
      `${context}: refused USDC transfer ${amount} units (max ${MAX_MAINNET_USDC_PER_TX} = 1 USDC)`,
    );
  }
}