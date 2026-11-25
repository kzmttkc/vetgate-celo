import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { RequestHandler } from "express";
import { createApp } from "../src/app.js";
import { DailyHumanQuota, deriveFreePermitNonce } from "../src/daily-quota.js";

const ORACLE_PK = generatePrivateKey();
const oracleAddr = privateKeyToAccount(ORACLE_PK).address;
const payGuard = "0x00000000000000000000000000000000000000aa" as const;

const fetchAllow = () =>
  vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ recommendation: "ALLOW" }),
  });

function mockSelfAgent(
  address: string,
  nullifier: string,
  agentId: bigint,
): RequestHandler {
  return (req, _res, next) => {
    req.agent = {
      address,
      agentKey: "0x",
      agentId,
      agentCount: 2n,
      nullifier: BigInt(nullifier),
    };
    next();
  };
}

const permitQuery = {
  payTo: "0x2222222222222222222222222222222222222222",
  buyer: "0x3333333333333333333333333333333333333333",
  sellerUrl: "https://example.com/seller",
};

describe("free quota (chain-backed, per human per UTC day)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("derives the same free nonce for the same nullifier across different agent IDs", async () => {
    const nullifier = "424242";
    expect(deriveFreePermitNonce(nullifier)).toBe(deriveFreePermitNonce(nullifier));

    const readMock = vi.fn().mockResolvedValue(false);
    const agentA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const agentB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    const app = createApp({
      payTo: oracleAddr,
      payGuardAddress: payGuard,
      oraclePrivateKey: ORACLE_PK,
      selfAuth: mockSelfAgent(agentA, nullifier, 1n),
      dailyQuota: new DailyHumanQuota(),
      vet402Fetch: fetchAllow() as unknown as typeof fetch,
      readPayGuardNonceUsed: readMock,
    });

    const app2 = createApp({
      payTo: oracleAddr,
      payGuardAddress: payGuard,
      oraclePrivateKey: ORACLE_PK,
      selfAuth: mockSelfAgent(agentB, nullifier, 2n),
      dailyQuota: new DailyHumanQuota(),
      vet402Fetch: fetchAllow() as unknown as typeof fetch,
      readPayGuardNonceUsed: readMock,
    });

    const res1 = await request(app).get("/v1/permit").query(permitQuery);
    const res2 = await request(app2).get("/v1/permit").query(permitQuery);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.body.tier).toBe("free");
    expect(res2.body.tier).toBe("free");
    expect(res1.body.permit.nonce).toBe(deriveFreePermitNonce(nullifier));
    expect(res2.body.permit.nonce).toBe(res1.body.permit.nonce);
    expect(res1.body.freeQuota?.key).toBe(res1.body.permit.nonce);
  });

  it("returns 402 when PayGuard.usedNonces is true (second agent, fresh instance cache)", async () => {
    const nullifier = "777";
    const key = deriveFreePermitNonce(nullifier);
    const readMock = vi.fn().mockResolvedValue(true);

    const app = createApp({
      payTo: oracleAddr,
      payGuardAddress: payGuard,
      oraclePrivateKey: ORACLE_PK,
      selfAuth: mockSelfAgent(
        "0xcccccccccccccccccccccccccccccccccccccccc",
        nullifier,
        3n,
      ),
      dailyQuota: new DailyHumanQuota(),
      vet402Fetch: fetchAllow() as unknown as typeof fetch,
      readPayGuardNonceUsed: readMock,
      enableX402: false,
    });

    const res = await request(app).get("/v1/permit").query(permitQuery);
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("x402_payment_required");
    expect(res.body.freeQuota).toEqual({
      key,
      used: true,
      scope: "per human per UTC day, shared across all agents of that human",
    });
    expect(readMock).toHaveBeenCalledWith(payGuard, key);
  });

  it("tracks independent nullifiers separately", async () => {
    const readMock = vi.fn().mockResolvedValue(false);

    const app1 = createApp({
      payTo: oracleAddr,
      payGuardAddress: payGuard,
      oraclePrivateKey: ORACLE_PK,
      selfAuth: mockSelfAgent(
        "0xdddddddddddddddddddddddddddddddddddddddd",
        "100",
        1n,
      ),
      dailyQuota: new DailyHumanQuota(),
      vet402Fetch: fetchAllow() as unknown as typeof fetch,
      readPayGuardNonceUsed: readMock,
    });

    const app2 = createApp({
      payTo: oracleAddr,
      payGuardAddress: payGuard,
      oraclePrivateKey: ORACLE_PK,
      selfAuth: mockSelfAgent(
        "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "200",
        2n,
      ),
      dailyQuota: new DailyHumanQuota(),
      vet402Fetch: fetchAllow() as unknown as typeof fetch,
      readPayGuardNonceUsed: readMock,
    });

    const r1 = await request(app1).get("/v1/permit").query(permitQuery);
    const r2 = await request(app2).get("/v1/permit").query(permitQuery);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.permit.nonce).not.toBe(r2.body.permit.nonce);
  });

  it("returns 402 when PayGuard RPC read fails", async () => {
    const nullifier = "303";
    const key = deriveFreePermitNonce(nullifier);
    const readMock = vi.fn().mockRejectedValue(new Error("rpc down"));

    const app = createApp({
      payTo: oracleAddr,
      payGuardAddress: payGuard,
      oraclePrivateKey: ORACLE_PK,
      selfAuth: mockSelfAgent(
        "0xffffffffffffffffffffffffffffffffffffffff",
        nullifier,
        1n,
      ),
      dailyQuota: new DailyHumanQuota(),
      vet402Fetch: fetchAllow() as unknown as typeof fetch,
      readPayGuardNonceUsed: readMock,
      enableX402: false,
    });

    const res = await request(app).get("/v1/permit").query(permitQuery);
    expect(res.status).toBe(402);
    expect(res.body.freeQuota?.key).toBe(key);
    expect(res.body.freeQuota?.used).toBe(true);
  });
});