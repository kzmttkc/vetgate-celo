import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashTypedData } from "viem";

import { CELO_MAINNET_CHAIN_ID, CELO_MAINNET_USDC } from "../src/chain.js";
import { mintVetGatePermit } from "../src/permit.js";

describe("mintVetGatePermit EIP-712 domain", () => {
  const prev = process.env.VETGATE_CELO_NETWORK;

  beforeEach(() => {
    process.env.VETGATE_CELO_NETWORK = "mainnet";
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.VETGATE_CELO_NETWORK;
    else process.env.VETGATE_CELO_NETWORK = prev;
  });

  it("uses the active Celo runtime chainId and USDC on mainnet", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const payGuard = "0xde00a2f23792e3cadbf0088a1b93276748a5666c" as const;
    const permit = await mintVetGatePermit({
      buyer: account.address,
      payTo: "0x20faaca5f980e29639a0fcc6dca6988e18ed333b",
      maxAmount: 1_000_000n,
      payGuardAddress: payGuard,
      oracleAccount: account,
    });
    expect(permit.token).toBe(CELO_MAINNET_USDC);

    const digest = hashTypedData({
      domain: {
        name: "VetGatePayGuard",
        version: "1",
        chainId: CELO_MAINNET_CHAIN_ID,
        verifyingContract: payGuard,
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
        buyer: permit.buyer ?? account.address,
        payTo: permit.payTo,
        token: permit.token,
        maxAmount: BigInt(permit.maxAmount),
        expiresAt: BigInt(permit.expiresAt),
        nonce: permit.nonce,
        verdict: permit.verdictCode,
      },
    });
    expect(permit.signature).toMatch(/^0x[a-f0-9]+$/i);
    expect(permit.signature.length).toBe(132);
    expect(digest).toMatch(/^0x/);
  });
});