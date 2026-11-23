import { describe, expect, it } from "vitest";
import { decodeFunctionData, parseAbi, type Hex } from "viem";

import { attributionSuffix, attributionTagBytes } from "../src/attribution.js";
import { PLACEHOLDER_ATTRIBUTION_TAG } from "../src/chain.js";
import { buildPayWithPermitCalldata } from "../src/mainnet-runbook.js";

const PAY_GUARD_ABI = parseAbi([
  "function payWithPermit(address payTo, address token, uint256 amount, uint256 maxAmount, uint256 expiresAt, bytes32 nonce, uint8 verdict, bytes signature, bytes attributionTag) external",
]);

describe("payWithPermit calldata encoding", () => {
  it("encodes attributionTag as valid hex bytes (relay Invalid params otherwise)", () => {
    const tagged = buildPayWithPermitCalldata({
      payGuard: "0xde00a2f23792e3cadbf0088a1b93276748a5666c",
      payTo: "0x20faaca5f980e29639a0fcc6dca6988e18ed333b",
      token: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
      amount: 10_000n,
      verdict: 1,
    });
    expect(/^0x[0-9a-f]*$/i.test(tagged)).toBe(true);
    expect(tagged.toLowerCase()).not.toContain("lo_56284feb7672");

    const suffix = attributionSuffix(PLACEHOLDER_ATTRIBUTION_TAG);
    const inner = `0x${tagged.slice(2, tagged.length - (suffix.length - 2))}` as Hex;
    const decoded = decodeFunctionData({
      abi: PAY_GUARD_ABI,
      data: inner,
    });
    expect(decoded.args[8]).toBe(attributionTagBytes(PLACEHOLDER_ATTRIBUTION_TAG));
  });
});