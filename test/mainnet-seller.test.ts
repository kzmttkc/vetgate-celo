import { describe, it, expect } from "vitest";

import { MAINNET_ADMIN_ADDRESS } from "../src/chain.js";
import { resolveMainnetSellerPayTo } from "../src/mainnet-seller.js";

describe("mainnet seller resolution", () => {
  it("picks vet402 ALLOW Celo seller from built-in listing", async () => {
    const sellerUrl = "https://gateway.usebuy.ai/v1/social/tiktok/profile";
    const payTo = "0x20faaca5f980e29639a0fcc6dca6988e18ed333b";
    const fetchMock = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes(encodeURIComponent(sellerUrl))) {
        return new Response(JSON.stringify({ recommendation: "BLOCK" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          recommendation: "ALLOW",
          verified_terms: {
            pay_to: payTo,
            network: "eip155:42220",
          },
        }),
        { status: 200 },
      );
    };
    const res = await resolveMainnetSellerPayTo(fetchMock as typeof fetch);
    expect(res.source).toBe("vet402");
    expect(res.payTo.toLowerCase()).toBe(payTo.toLowerCase());
    expect(res.sellerUrl).toBe(sellerUrl);
  });

  it("falls back to team-controlled payTo when vet402 has no ALLOW", async () => {
    const fetchMock = async () =>
      new Response(
        JSON.stringify({ recommendation: "BLOCK", verified_pay_to_by_network: [] }),
        { status: 200 },
      );
    const res = await resolveMainnetSellerPayTo(fetchMock as typeof fetch);
    expect(res.source).toBe("controlled");
    expect(res.payTo.toLowerCase()).not.toBe(MAINNET_ADMIN_ADDRESS.toLowerCase());
  });
});