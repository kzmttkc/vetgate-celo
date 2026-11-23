/**
 * Altana buyer on Celo (testnet or mainnet via VETGATE_CELO_NETWORK).
 * Set VETGATE_ALTANA_MOCK=1 for ALLOW/BLOCK/revoke without relay RPC (unit tests / CI).
 */
import {
  createClient,
  CELO,
  CELO_SEPOLIA,
  signerFromPrivateKey,
  type Client,
  type Session,
} from "@altananetwork/sdk";
import { SelfAgent } from "@selfxyz/agent-sdk";
import { appendAttributionSuffix, attributionSuffix } from "./attribution.js";
import { encodeFunctionData, keccak256, parseAbi } from "viem";

import { resolveAttributionCode, resolveCeloRuntime } from "./chain.js";
import { PAY_WITH_PERMIT_CALL_SIG } from "./mainnet-runbook.js";

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

export type OraclePermitFields = NonNullable<OraclePermitResponse["permit"]>;

export async function executeSessionPayWithPermit(params: {
  client: Client;
  session: Session;
  payGuard: `0x${string}`;
  permit: OraclePermitFields;
  amountUnits: bigint;
  chainId?: number;
  attributionCode?: string;
}): Promise<{ transactionHash: `0x${string}`; attributionSuffix: `0x${string}` }> {
  const attributionCode = params.attributionCode ?? resolveAttributionCode();
  const innerCalldata = encodeFunctionData({
    abi: PAY_GUARD_ABI,
    functionName: "payWithPermit",
    args: [
      params.permit.payTo,
      params.permit.token,
      params.amountUnits,
      BigInt(params.permit.maxAmount),
      BigInt(params.permit.expiresAt),
      params.permit.nonce,
      params.permit.verdictCode,
      params.permit.signature,
      attributionCode,
    ],
  });
  const taggedData = appendAttributionSuffix(innerCalldata, attributionCode);
  const runtime = resolveCeloRuntime();
  const execRes = await params.client.execute({
    session: params.session,
    calls: [{ to: params.payGuard, data: taggedData }],
    chainId: params.chainId ?? runtime.chainId,
    feeToken: runtime.usdc,
  });
  const transactionHash =
    (execRes as { transactionHash?: `0x${string}` }).transactionHash ??
    (`0x${"00".repeat(32)}` as `0x${string}`);
  return { transactionHash, attributionSuffix: attributionSuffix(attributionCode) };
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
  const attributionCode = params.attributionCode ?? resolveAttributionCode();

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
    return {
      status: "paid_under_guard",
      execTxHash,
      attributionSuffix: attributionSuffix(attributionCode),
    };
  }

  const runtime = resolveCeloRuntime();
  const altanaChain = runtime.network === "mainnet" ? CELO : CELO_SEPOLIA;
  const client = createClient({ chains: [altanaChain] });
  const admin = signerFromPrivateKey(params.adminPrivateKey);
  const sessionSigner = signerFromPrivateKey(params.sessionPrivateKey);
  const wallet = await client.createWallet({ signer: admin });

  const session = await client.grantSession({
    wallet,
    signer: admin,
    sessionSigner,
    chainId: altanaChain.chainId,
    feeToken: runtime.usdc,
    permissions: {
      calls: [{ to: params.payGuardAddress, signature: PAY_WITH_PERMIT_CALL_SIG }],
      spend: [{ limit: 1_000_000n, period: "day", token: runtime.usdc }],
    },
    expiry: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  });

  const selfAgent = new SelfAgent({
    privateKey: params.selfAgentPrivateKey,
    network: runtime.selfNetwork,
    rpcUrl: runtime.rpc,
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
        chain: altanaChain.chain,
        transport: m.http(altanaChain.publicRpcUrl),
      }),
    );
    const activeAfterRevoke = await pub.readContract({
      address: altanaChain.keyStore,
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

  const { transactionHash: execTxHash, attributionSuffix: paidSuffix } =
    await executeSessionPayWithPermit({
      client,
      session,
      payGuard: params.payGuardAddress,
      permit: oracle.permit,
      amountUnits: params.amountUnits,
      chainId: altanaChain.chainId,
      attributionCode,
    });

  return { status: "paid_under_guard", execTxHash, attributionSuffix: paidSuffix };
}