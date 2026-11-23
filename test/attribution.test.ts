import { describe, it, expect } from "vitest";
import { encodeDeployData, encodeFunctionData, parseAbi } from "viem";
import { buildErc8004RegisterCall } from "@altananetwork/sdk";
import { generatePrivateKey } from "viem/accounts";

import { fromDataSuffix } from "@celo/attribution-tags";
import {
  appendAttributionSuffix,
  attributionSuffix,
  calldataIncludesAttribution,
} from "../src/attribution.js";
import { PLACEHOLDER_ATTRIBUTION_TAG, CELO_MAINNET_CHAIN_ID } from "../src/chain.js";
import {
  buildDeployPayGuardCalldata,
  buildPayWithPermitCalldata,
  buildRegisterErc8004Calldata,
} from "../src/mainnet-runbook.js";

const PAY_GUARD_ABI = parseAbi([
  "constructor(address _oracleSigner)",
  "function payWithPermit(address payTo, address token, uint256 amount, uint256 maxAmount, uint256 expiresAt, bytes32 nonce, uint8 verdict, bytes signature, bytes attributionTag) external",
]);

describe("ERC-8021 attribution suffix on every write path", () => {
  const code = PLACEHOLDER_ATTRIBUTION_TAG;
  const oracle = "0x970b37B3C58eDc62Cccb7BeeaB5972bC7c6b0435" as const;

  it("PayGuard deploy calldata", () => {
    const tagged = buildDeployPayGuardCalldata(oracle);
    expect(calldataIncludesAttribution(tagged, code)).toBe(true);
  });

  it("payWithPermit inner + suffix (Altana execute)", () => {
    const tagged = buildPayWithPermitCalldata({
      payGuard: "0x00000000000000000000000000000000000000aa",
      payTo: oracle,
      token: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
      amount: 10_000n,
      verdict: 1,
    });
    expect(calldataIncludesAttribution(tagged, code)).toBe(true);
  });

  it("ERC-8004 register call", () => {
    const tagged = buildRegisterErc8004Calldata();
    expect(calldataIncludesAttribution(tagged, code)).toBe(true);
    const bare = buildErc8004RegisterCall(CELO_MAINNET_CHAIN_ID, "https://vetgate-celo.local/agent-registration.json", [
      { metadataKey: "x402Support", metadataValue: "0x" + Buffer.from("true", "utf8").toString("hex") },
    ]);
    expect(tagged).toEqual(appendAttributionSuffix(bare.data, code));
  });

  it("x402 buyer path when client allows data suffix", () => {
    const paymentCalldata = "0xdeadbeef" as const;
    const tagged = appendAttributionSuffix(paymentCalldata, code);
    expect(calldataIncludesAttribution(tagged, code)).toBe(true);
  });

  it("suffix helper is stable", () => {
    expect(attributionSuffix(code)).toMatch(/^0x/);
    const inner = encodeDeployData({
      abi: PAY_GUARD_ABI,
      bytecode: "0x6000",
      args: [oracle],
    });
    expect(calldataIncludesAttribution(appendAttributionSuffix(inner), code)).toBe(true);
  });

  it("agent-buyer mock path returns suffix", async () => {
    const { runGuardedProcurement } = await import("../src/agent-buyer.js");
    process.env.VETGATE_ALTANA_MOCK = "1";
    const res = await runGuardedProcurement({
      adminPrivateKey: generatePrivateKey(),
      sessionPrivateKey: generatePrivateKey(),
      selfAgentPrivateKey: generatePrivateKey(),
      payGuardAddress: "0x00000000000000000000000000000000000000aa",
      targetPayTo: oracle,
      amountUnits: 10_000n,
      vetgateUrl: "http://localhost",
      sellerUrl: "https://example.com/ok",
      mockOracle: {
        verdict: "ALLOW",
        permit: {
          payTo: oracle,
          token: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
          maxAmount: "1000000",
          expiresAt: `${Math.floor(Date.now() / 1000) + 300}`,
          nonce: `0x${"11".repeat(32)}`,
          verdictCode: 1,
          signature: `0x${"22".repeat(65)}`,
        },
      },
    });
    expect(res.status).toBe("paid_under_guard");
    if (res.status === "paid_under_guard") {
      const decoded = fromDataSuffix(res.attributionSuffix)?.codes ?? [];
      expect(decoded).toContain(code);
    }
  });
});