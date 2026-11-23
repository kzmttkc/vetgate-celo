import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { runGuardedProcurement } from "../src/agent-buyer.js";

describe("agent-buyer (Altana mock)", () => {
  const oldEnv = process.env.VETGATE_ALTANA_MOCK;

  beforeEach(() => {
    process.env.VETGATE_ALTANA_MOCK = "1";
  });

  afterEach(() => {
    if (oldEnv === undefined) delete process.env.VETGATE_ALTANA_MOCK;
    else process.env.VETGATE_ALTANA_MOCK = oldEnv;
  });

  it("executes pay path on ALLOW with attribution suffix", async () => {
    const res = await runGuardedProcurement({
      adminPrivateKey: generatePrivateKey(),
      sessionPrivateKey: generatePrivateKey(),
      selfAgentPrivateKey: generatePrivateKey(),
      payGuardAddress: "0x00000000000000000000000000000000000000aa",
      targetPayTo: "0x2222222222222222222222222222222222222222",
      amountUnits: 10_000n,
      vetgateUrl: "http://localhost",
      sellerUrl: "https://example.com/ok",
      mockOracle: {
        verdict: "ALLOW",
        permit: {
          payTo: "0x2222222222222222222222222222222222222222",
          token: "0x01C5C0122039549AD1493B8220cABEdD739BC44E",
          maxAmount: "1000000",
          expiresAt: `${Math.floor(Date.now() / 1000) + 300}`,
          nonce: `0x${"11".repeat(32)}`,
          verdictCode: 1,
          signature: `0x${"22".repeat(65)}`,
        },
      },
      mockExecuteTxHash: `0x${"cc".repeat(32)}`,
    });

    expect(res.status).toBe("paid_under_guard");
    if (res.status === "paid_under_guard") {
      expect(res.execTxHash).toMatch(/^0x/);
      expect(res.attributionSuffix).toMatch(/^0x/);
      const { fromDataSuffix } = await import("@celo/attribution-tags");
      expect(fromDataSuffix(res.attributionSuffix)?.codes).toContain("celo_56284feb7672");
    }
  });

  it("revokes on BLOCK without permit", async () => {
    const res = await runGuardedProcurement({
      adminPrivateKey: generatePrivateKey(),
      sessionPrivateKey: generatePrivateKey(),
      selfAgentPrivateKey: generatePrivateKey(),
      payGuardAddress: "0x00000000000000000000000000000000000000aa",
      targetPayTo: "0x2222222222222222222222222222222222222222",
      amountUnits: 10_000n,
      vetgateUrl: "http://localhost",
      sellerUrl: "https://example.com/bad",
      mockOracle: { verdict: "BLOCK", permit: null },
    });

    expect(res.status).toBe("revoked_and_stopped");
    if (res.status === "revoked_and_stopped") {
      expect(res.revoked).toBe(true);
      expect(res.sessionActiveAfter).toBe(false);
    }
  });
});