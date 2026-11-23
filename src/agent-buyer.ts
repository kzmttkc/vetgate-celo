/**
 * Altana buyer on Celo Sepolia (11142220). Live path uses @altananetwork/sdk CELO_SEPOLIA;
 * set VETGATE_ALTANA_MOCK=1 to exercise ALLOW/BLOCK/revoke without relay RPC (unit tests / CI).
 */
import { createClient, CELO_SEPOLIA, signerFromPrivateKey } from "@altananetwork/sdk";
import { SelfAgent } from "@selfxyz/agent-sdk";
import { toDataSuffix } from "@celo/attribution-tags";
import {
  concat,
  encodeFunctionData,
  keccak256,
  parseAbi,
} from "viem";

import {
  CELO_SEPOLIA_RPC,
  CELO_SEPOLIA_USDC,
  PLACEHOLDER_ATTRIBUTION_TAG,
} from "./chain.js";

const PAY_GUARD_ABI = parseAbi([
  "function payWithPermit(address payTo, address token, uint256 amount, uint256 maxAmount, uint256 expiresAt, bytes32 nonce, uint8 verdict, bytes signature, bytes attributionTag) external",
]);

const KEYSTORE_ABI = parseAbi([
  "function isValidKey(address user, bytes32 keyId) view returns (bool)",
]);

export type OraclePermitResponse = {
  verdict: string;
  permit: {
    payTo: `0x${string}`;
    token: `0x${string}`;
    maxAmount: string;
    expiresAt: string;
    nonce: `0x${string}`;
    verdictCode: number;
    signature: `0x${string}`;
  } | null;
};

export type GuardedProcurementParams = {
  adminPrivateKey: `0x${string}`;
  sessionPrivateKey: `0x${string}`;
  selfAgentPrivateKey: `0x${string}`;
  payGuardAddress: `0x${string}`;
  targetPayTo: `0x${string}`;
  amountUnits: bigint;
  vetgateUrl: string;
  sellerUrl: string;
  attributionCode?: string;
  /** Injected mock oracle response (tests). */
  mockOracle?: OraclePermitResponse;
  /** Injected mock execute result when VETGATE_ALTANA_MOCK=1. */
  mockExecuteTxHash?: `0x${string}`;
};

export type GuardedProcurementResult =
  | { status: "paid_under_guard"; execTxHash: `0x${string}`; attributionSuffix: `0x${string}` }
  | { status: "revoked_and_stopped"; verdict: string; revoked: true; sessionActiveAfter: boolean };

function useAltanaMock(): boolean {
  return process.env.VETGATE_ALTANA_MOCK === "1";
}

export async function fetchOraclePermit(
  selfAgent: SelfAgent,
  vetgateUrl: string,
  targetPayTo: `0x${string}`,
  buyer: `0x${string}`,
  sellerUrl: string,
): Promise<OraclePermitResponse> {
  const url = new URL(`${vetgateUrl}/v1/permit`);
  url.searchParams.set("payTo", targetPayTo);
  url.searchParams.set("buyer", buyer);
  url.searchParams.set("sellerUrl", sellerUrl);
  url.searchParams.set("maxAmount", "1000000");
  const resp = await selfAgent.fetch(url.toString());
  return (await resp.json()) as OraclePermitResponse;
}

export async function runGuardedProcurement(
  params: GuardedProcurementParams,
): Promise<GuardedProcurementResult> {
  const attributionCode = params.attributionCode ?? PLACEHOLDER_ATTRIBUTION_TAG;
  const attributionSuffix = toDataSuffix(attributionCode);

  if (useAltanaMock()) {
    const oracle = params.mockOracle ?? {
      verdict: "BLOCK",
      permit: null,
    };
    if (oracle.verdict !== "ALLOW" || !oracle.permit) {
      return {
        status: "revoked_and_stopped",
        verdict: oracle.verdict,
        revoked: true,
        sessionActiveAfter: false,
      };
    }
    const execTxHash =
      params.mockExecuteTxHash ?? (`0x${"ab".repeat(32)}` as `0x${string}`);
    return { status: "paid_under_guard", execTxHash, attributionSuffix };
  }

  const client = createClient({ chains: [CELO_SEPOLIA] });
  const admin = signerFromPrivateKey(params.adminPrivateKey);
  const sessionSigner = signerFromPrivateKey(params.sessionPrivateKey);
  const wallet = await client.createWallet({ signer: admin });

  const session = await client.grantSession({
    wallet,
    signer: admin,
    sessionSigner,
    chainId: CELO_SEPOLIA.chainId,
    feeToken: CELO_SEPOLIA_USDC,
    permissions: {
      calls: [{ to: params.payGuardAddress }],
      spend: [{ limit: 1_000_000n, period: "day", token: CELO_SEPOLIA_USDC }],
    },
    expiry: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  });

  const selfAgent = new SelfAgent({
    privateKey: params.selfAgentPrivateKey,
    network: "testnet",
    rpcUrl: CELO_SEPOLIA_RPC,
  });

  const oracle = params.mockOracle
    ? params.mockOracle
    : await fetchOraclePermit(
        selfAgent,
        params.vetgateUrl,
        params.targetPayTo,
        wallet.address,
        params.sellerUrl,
      );

  if (oracle.verdict !== "ALLOW" || !oracle.permit) {
    await client.revokeSession({ wallet, signer: admin, session });
    const pub = await import("viem").then((m) =>
      m.createPublicClient({
        chain: CELO_SEPOLIA.chain,
        transport: m.http(CELO_SEPOLIA.publicRpcUrl),
      }),
    );
    const activeAfterRevoke = await pub.readContract({
      address: CELO_SEPOLIA.keyStore,
      abi: KEYSTORE_ABI,
      functionName: "isValidKey",
      args: [wallet.address, keccak256(session.publicKey as `0x${string}`)],
    });
    return {
      status: "revoked_and_stopped",
      verdict: oracle.verdict,
      revoked: true,
      sessionActiveAfter: activeAfterRevoke,
    };
  }

  const innerCalldata = encodeFunctionData({
    abi: PAY_GUARD_ABI,
    functionName: "payWithPermit",
    args: [
      oracle.permit.payTo,
      oracle.permit.token,
      params.amountUnits,
      BigInt(oracle.permit.maxAmount),
      BigInt(oracle.permit.expiresAt),
      oracle.permit.nonce,
      oracle.permit.verdictCode,
      oracle.permit.signature,
      attributionCode,
    ],
  });
  const taggedData = concat([innerCalldata, attributionSuffix]);

  const execRes = await client.execute({
    wallet,
    session,
    calls: [{ to: params.payGuardAddress, data: taggedData }],
  });

  const execTxHash =
    (execRes as { transactionHash?: `0x${string}` }).transactionHash ??
    (`0x${"00".repeat(32)}` as `0x${string}`);

  return { status: "paid_under_guard", execTxHash, attributionSuffix };
}