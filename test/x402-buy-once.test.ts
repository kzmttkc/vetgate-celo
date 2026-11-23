import { describe, it, expect } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { CELO_MAINNET_CAIP2, CELO_MAINNET_USDC } from "../src/chain.js";
import {
  assertBuyOncePriceCap,
  buildEip3009SignPreview,
  createBuyOnceX402Client,
  isCeloMainnetNetwork,
  parseUsdcUnits,
  selectCeloMainnetAccept,
} from "../src/x402-buy-once.js";

const SAMPLE_402 = {
  x402Version: 1,
  accepts: [
    {
      scheme: "exact",
      network: "celo-sepolia",
      maxAmountRequired: "1000",
      payTo: "0x20faaca5f980e29639a0fcc6dca6988e18ed333b",
      asset: CELO_MAINNET_USDC,
    },
    {
      scheme: "exact",
      network: "celo",
      maxAmountRequired: "5000",
      payTo: "0x20faaca5f980e29639a0fcc6dca6988e18ed333b",
      asset: CELO_MAINNET_USDC,
      extra: { name: "USDC", version: "2" },
    },
  ],
} as const;

describe("x402 buy-once guards", () => {
  it("recognizes Celo mainnet network aliases", () => {
    expect(isCeloMainnetNetwork("celo")).toBe(true);
    expect(isCeloMainnetNetwork("eip155:42220")).toBe(true);
    expect(isCeloMainnetNetwork("celo-sepolia")).toBe(false);
  });

  it("selects Celo mainnet exact USDC accept", () => {
    const accept = selectCeloMainnetAccept(SAMPLE_402);
    expect(accept.network).toBe("celo");
    expect(accept.maxAmountRequired).toBe("5000");
  });

  it("refuses amounts above 0.05 USDC", () => {
    expect(() => assertBuyOncePriceCap(parseUsdcUnits("50001"))).toThrow(/refused/);
    expect(() => assertBuyOncePriceCap(parseUsdcUnits("5000"))).not.toThrow();
  });

  it("builds EIP-3009 preview for dry output", () => {
    const accept = selectCeloMainnetAccept(SAMPLE_402);
    const preview = buildEip3009SignPreview({
      accept,
      payer: "0x970b37B3C58eDc62Cccb7BeeaB5972bC7c6b0435",
      nowSec: 1_700_000_000,
    });
    expect(preview.primaryType).toBe("TransferWithAuthorization");
    expect(preview.domain.verifyingContract.toLowerCase()).toBe(CELO_MAINNET_USDC.toLowerCase());
    expect(preview.message.value).toBe("5000");
  });

  it("registers x402 v2 exact EVM client for eip155:42220", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const client = createBuyOnceX402Client(account);
    const payload = await client.createPaymentPayload({
      x402Version: 2,
      resource: {
        url: "https://gateway.usebuy.ai/v1/social/tiktok/profile",
        description: "Return public TikTok profile data by username.",
        mimeType: "application/json",
      },
      accepts: [
        {
          scheme: "exact",
          network: CELO_MAINNET_CAIP2,
          amount: "5000",
          asset: CELO_MAINNET_USDC,
          payTo: "0x20faAca5F980E29639A0FCC6dcA6988E18ed333B",
          maxTimeoutSeconds: 300,
          extra: { name: "USDC", version: "2" },
        },
      ],
    });
    expect(payload.x402Version).toBe(2);
    expect(payload.accepted?.network).toBe(CELO_MAINNET_CAIP2);
    expect(payload.accepted?.amount).toBe("5000");
  });
});