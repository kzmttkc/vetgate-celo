import { spawnSync } from "node:child_process";
import { join } from "node:path";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { RequestHandler } from "express";
import { createApp } from "../src/app.js";
import { DailyHumanQuota } from "../src/daily-quota.js";
import {
  MISSING_AGENT_KEYS_MESSAGE,
  agentKeyFilesPresent,
  formatDemoLine,
  resolveAgentKeyPaths,
} from "../scripts/two-agent-demo.js";

const ORACLE_PK = generatePrivateKey();
const oracleAddr = privateKeyToAccount(ORACLE_PK).address;
const payGuard = "0x00000000000000000000000000000000000000aa" as const;

const permitQuery = {
  payTo: "0x2222222222222222222222222222222222222222",
  buyer: "0x3333333333333333333333333333333333333333",
  sellerUrl: "https://example.com/seller",
};

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

const fetchAllow = () =>
  vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ recommendation: "ALLOW" }),
  });

describe("two-agent-demo script", () => {
  const repoRoot = join(import.meta.dirname, "..");

  it("exits 2 with guidance when agent key files are missing", () => {
    const paths = resolveAgentKeyPaths([]);
    expect(agentKeyFilesPresent(paths)).toBe(false);

    const run = spawnSync(
      "npx",
      ["tsx", "scripts/two-agent-demo.ts"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          VETGATE_AGENT_A_KEY_FILE: "/nonexistent/agent-a.key",
          VETGATE_AGENT_B_KEY_FILE: "/nonexistent/agent-b.key",
        },
        encoding: "utf8",
      },
    );

    expect(run.status).toBe(2);
    expect(run.stdout.trim()).toBe(MISSING_AGENT_KEYS_MESSAGE);
  });

  it("formats one-line demo output", () => {
    expect(formatDemoLine(1, 401, "no Self signature")).toBe(
      "(1) no Self signature → HTTP 401",
    );
  });
});

describe("two-agent-demo flow (testnet app, mocked Self agents)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("agent B returns 402 with same freeQuota.key after agent A consumed free slot", async () => {
    const nullifier = "606060";
    const sharedQuota = new DailyHumanQuota();
    const readMock = vi.fn().mockResolvedValue(false);

    const baseCfg = {
      payTo: oracleAddr,
      payGuardAddress: payGuard,
      oraclePrivateKey: ORACLE_PK,
      dailyQuota: sharedQuota,
      vet402Fetch: fetchAllow() as unknown as typeof fetch,
      readPayGuardNonceUsed: readMock,
      enableX402: false,
    };

    const appA = createApp({
      ...baseCfg,
      selfAuth: mockSelfAgent(
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        nullifier,
        1n,
      ),
    });

    const appB = createApp({
      ...baseCfg,
      selfAuth: mockSelfAgent(
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        nullifier,
        2n,
      ),
    });

    const noSigApp = createApp({
      payTo: oracleAddr,
      payGuardAddress: payGuard,
      oraclePrivateKey: ORACLE_PK,
    });

    const res401 = await request(noSigApp).get("/v1/permit").query(permitQuery);
    expect(res401.status).toBe(401);

    const resA = await request(appA).get("/v1/permit").query(permitQuery);
    expect(resA.status).toBe(200);
    expect(resA.body.tier).toBe("free");
    const keyA = resA.body.freeQuota?.key as string;

    const resB = await request(appB).get("/v1/permit").query(permitQuery);
    expect(resB.status).toBe(402);
    expect(resB.body.error).toBe("x402_payment_required");
    expect(resB.body.freeQuota?.key).toBe(keyA);
    expect(readMock).toHaveBeenCalled();
  });
});