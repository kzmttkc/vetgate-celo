import { describe, it, expect } from "vitest";

import { MAINNET_ADMIN_ADDRESS } from "../src/chain.js";
import { resolveMainnetSellerPayTo } from "../src/mainnet-seller.js";

describe("mainnet seller resolution", () => {
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