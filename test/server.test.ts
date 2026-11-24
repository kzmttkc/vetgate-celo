import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { RequestHandler } from "express";
import { createApp } from "../src/app.js";
import { DailyHumanQuota } from "../src/daily-quota.js";
import { StatsStore } from "../src/stats.js";

const ORACLE_PK = generatePrivateKey();
const oracleAddr = privateKeyToAccount(ORACLE_PK).address;

function mockSelfAgent(address: string, nullifier = "42"): RequestHandler {
  return (req, _res, next) => {
    req.agent = {
      address,
      agentKey: "0x",
      agentId: 1n,
      agentCount: 1n,
      nullifier: BigInt(nullifier),
    };
    next();
  };
}

const fakeSelfAuthNoAgent: RequestHandler = (_req, _res, done) => {
  done();
};

const fakeSelfAuthVerifyFail: RequestHandler = (_req, _res, done) => {
  done(new Error("invalid self agent signature"));
};

describe("VetGate server", () => {
  const payGuard = "0x00000000000000000000000000000000000000aa" as const;
  const teamWallet = "0x1111111111111111111111111111111111111111";

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes /health without auth", async () => {
    const app = createApp({
      payTo: oracleAddr,
      payGuardAddress: payGuard,
      oraclePrivateKey: ORACLE_PK,
    });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 401 JSON when Self agent is missing after verification", async () => {
    const app = createApp({
      payTo: oracleAddr,
      payGuardAddress: payGuard,
      oraclePrivateKey: ORACLE_PK,
      selfAuth: fakeSelfAuthNoAgent,
    });
    const res = await request(app).get("/v1/permit");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("self_agent_required");
  });

  it("returns 403 JSON when Self verification fails", async () => {
    const app = createApp({
      payTo: oracleAddr,
      payGuardAddress: payGuard,
      oraclePrivateKey: ORACLE_PK,
      selfAuth: fakeSelfAuthVerifyFail,
    });
    const res = await request(app).get("/v1/permit");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("self_verification_failed");
  });

  it("issues ALLOW permit on free human quota", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ recommendation: "ALLOW" }),
    });
    const quota = new DailyHumanQuota();
    const stats = new StatsStore(new Set([teamWallet.toLowerCase()]));
    const app = createApp({
      payTo: oracleAddr,
      payGuardAddress: payGuard,
      oraclePrivateKey: ORACLE_PK,
      selfAuth: mockSelfAgent(teamWallet, "7"),
      teamWalletsCsv: teamWallet,
      dailyQuota: quota,
      stats,
      vet402Fetch: fetchMock as unknown as typeof fetch,
    });

    const res = await request(app)
      .get("/v1/permit")
      .query({
        payTo: "0x2222222222222222222222222222222222222222",
        buyer: "0x3333333333333333333333333333333333333333",
        sellerUrl: "https://example.com/seller",
      });

    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("ALLOW");
    expect(res.body.tier).toBe("free");
    expect(res.body.permit?.signature).toMatch(/^0x/);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/check?url="),
    );
    const snap = stats.snapshot();
    expect(snap.team.free).toBe(1);
    expect(snap.independent.free).toBe(0);
  });

  it("returns permit null when vet402 is BLOCK", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ recommendation: "BLOCK" }),
    });
    const app = createApp({
      payTo: oracleAddr,
      payGuardAddress: payGuard,
      oraclePrivateKey: ORACLE_PK,
      selfAuth: mockSelfAgent("0x4444444444444444444444444444444444444444"),
      vet402Fetch: fetchMock as unknown as typeof fetch,
    });

    const res = await request(app).get("/v1/permit").query({
      payTo: "0x2222222222222222222222222222222222222222",
      buyer: "0x3333333333333333333333333333333333333333",
      sellerUrl: "https://example.com/bad",
    });

    expect(res.status).toBe(200);
    expect(res.body.permit).toBeNull();
    expect(res.body.verdict).toBe("BLOCK");
  });

  it("returns synthetic 402 after free quota exhausted", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ recommendation: "ALLOW" }),
    });
    const quota = new DailyHumanQuota();
    quota.consumeFreeSlot("99");
    const app = createApp({
      payTo: oracleAddr,
      payGuardAddress: payGuard,
      oraclePrivateKey: ORACLE_PK,
      selfAuth: mockSelfAgent("0x5555555555555555555555555555555555555555", "99"),
      dailyQuota: quota,
      vet402Fetch: fetchMock as unknown as typeof fetch,
      enableX402: false,
    });

    const res = await request(app).get("/v1/permit").query({
      payTo: "0x2222222222222222222222222222222222222222",
      buyer: "0x3333333333333333333333333333333333333333",
      sellerUrl: "https://example.com/seller",
    });

    expect(res.status).toBe(402);
    expect(res.body.error).toBe("x402_payment_required");
    expect(res.body.network).toBe("eip155:11142220");
  });

  it("exposes stats split", async () => {
    const stats = new StatsStore(new Set());
    stats.record("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "free");
    stats.record("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "paid");
    const app = createApp({
      payTo: oracleAddr,
      payGuardAddress: payGuard,
      oraclePrivateKey: ORACLE_PK,
      selfAuth: mockSelfAgent("0xcccccccccccccccccccccccccccccccccccccccc"),
      stats,
    });

    const res = await request(app).get("/v1/stats");
    expect(res.status).toBe(200);
    expect(res.body.stats.independent.free).toBe(1);
    expect(res.body.stats.independent.paid).toBe(1);
  });
});