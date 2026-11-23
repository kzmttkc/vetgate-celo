import { randomBytes } from "node:crypto";
import type { Account } from "viem/accounts";
import { resolveCeloRuntime } from "./chain.js";

export const VERDICT_ALLOW = 1;

export type VetGatePermitPayload = {
  buyer: `0x${string}`;
  payTo: `0x${string}`;
  token: `0x${string}`;
  maxAmount: string;
  expiresAt: string;
  nonce: `0x${string}`;
  verdictCode: number;
  signature: `0x${string}`;
};

export type MintPermitParams = {
  buyer: `0x${string}`;
  payTo: `0x${string}`;
  maxAmount: bigint;
  payGuardAddress: `0x${string}`;
  oracleAccount: Account;
  token?: `0x${string}`;
  ttlSeconds?: number;
};

export async function mintVetGatePermit(params: MintPermitParams): Promise<VetGatePermitPayload> {
  const runtime = resolveCeloRuntime();
  const expiresAt = BigInt(
    Math.floor(Date.now() / 1000) + (params.ttlSeconds ?? 300),
  );
  const nonce = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
  const token = params.token ?? runtime.usdc;

  if (!params.oracleAccount.signTypedData) {
    throw new Error("Oracle account cannot sign typed data");
  }
  const signature = await params.oracleAccount.signTypedData({
    domain: {
      name: "VetGatePayGuard",
      version: "1",
      chainId: runtime.chainId,
      verifyingContract: params.payGuardAddress,
    },
    types: {
      VetGatePermit: [
        { name: "buyer", type: "address" },
        { name: "payTo", type: "address" },
        { name: "token", type: "address" },
        { name: "maxAmount", type: "uint256" },
        { name: "expiresAt", type: "uint256" },
        { name: "nonce", type: "bytes32" },
        { name: "verdict", type: "uint8" },
      ],
    },
    primaryType: "VetGatePermit",
    message: {
      buyer: params.buyer,
      payTo: params.payTo,
      token,
      maxAmount: params.maxAmount,
      expiresAt,
      nonce,
      verdict: VERDICT_ALLOW,
    },
  });

  return {
    buyer: params.buyer,
    payTo: params.payTo,
    token,
    maxAmount: params.maxAmount.toString(),
    expiresAt: expiresAt.toString(),
    nonce,
    verdictCode: VERDICT_ALLOW,
    signature,
  };
}