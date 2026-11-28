import request from "supertest";
import { describe, it, expect, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../src/app.js";
import { DailyHumanQuota } from "../src/daily-quota.js";
import {
  ERC8004_HEADERS,
  erc8004RequestMessage,
  verifyErc8004Request,
  type Erc8004Reader,
} from "../src/erc8004-auth.js";

const ORACLE_PK = generatePrivateKey();
const oracleAddr = privateKeyToAccount(ORACLE_PK).address;
const payGuard = "0x00000000000000000000000000000000000000aa" as const;
const owner = privateKeyToAccount(generatePrivateKey());
const wallet = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

const reader: Erc8004Reader = {
  ownerOf: async (id) => (id === 9966n ? owner.address : null),
  agentWallet: async (id) => (id === 9966n ? wallet.address : null),
};

const path =
  "/v1/permit?payTo=0x2222222222222222222222222222222222222222&buyer=0x3333333333333333333333333333333333333333&sellerUrl=https%3A%2F%2Fexample.com%2Fseller";

async function signed(signer: typeof owner, agentId = "9966", ts = Math.floor(Date.now() / 1000)) {
  const timestamp = String(ts);
  const signature = await signer.signMessage({
    message: erc8004RequestMessage("GET", path, timestamp, agentId),
  });
  return {
    [ERC8004_HEADERS.AGENT_ID]: agentId,
    [ERC8004_HEADERS.SIGNATURE]: signature,
    [ERC8004_HEADERS.TIMESTAMP]: timestamp,
  };
}

function app() {
  return createApp({
    payTo: oracleAddr,
    payGuardAddress: payGuard,
    oraclePrivateKey: ORACLE_PK,
    erc8004Reader: reader,
    dailyQuota: new DailyHumanQuota(),
    vet402Fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ recommendation: "ALLOW" }) }) as unknown as typeof fetch,
    readPayGuardNonceUsed: vi.fn().mockResolvedValue(false),
  });
}

describe("ERC-8004 path (agent without a Self Agent ID)", () => {
  it("accepts a request signed by the agent owner and goes straight to payment (no free quota)", async () => {
    const res = await request(app()).get(path).set(await signed(owner));
    expect(res.status).toBe(402);
    expect(res.body.freeQuota).toBeUndefined();
  });

  it("accepts a request signed by the registered agent wallet", async () => {
    const res = await request(app()).get(path).set(await signed(wallet));
    expect(res.status).toBe(402);
  });

  it("rejects a signer that is neither owner nor agent wallet", async () => {
    const res = await request(app()).get(path).set(await signed(stranger));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("erc8004_not_owner");
  });

  it("rejects an unknown agent id", async () => {
    const res = await request(app()).get(path).set(await signed(owner, "1"));
    expect(res.status).toBe(403);
  });

  it("rejects a stale timestamp", async () => {
    const res = await request(app()).get(path).set(await signed(owner, "9966", Math.floor(Date.now() / 1000) - 3600));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("erc8004_stale");
  });

  it("rejects a signature made for a different URL (no replay across queries)", async () => {
    const h = await signed(owner);
    const res = await request(app()).get(path.replace("seller", "other")).set(h);
    expect(res.status).toBe(403);
  });

  it("rejects missing companion headers", async () => {
    const res = await request(app()).get(path).set({ [ERC8004_HEADERS.AGENT_ID]: "9966" });
    expect(res.status).toBe(401);
  });

  it("still requires Self or ERC-8004 when neither is sent", async () => {
    const res = await request(app()).get(path);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("self_agent_required");
  });

  it("fails closed when the registry cannot be read", async () => {
    const broken: Erc8004Reader = {
      ownerOf: async () => {
        throw new Error("rpc down");
      },
      agentWallet: async () => null,
    };
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = await owner.signMessage({ message: erc8004RequestMessage("GET", path, ts, "9966") });
    const r = await verifyErc8004Request({ method: "GET", originalUrl: path, agentIdHeader: "9966", signature, timestamp: ts, reader: broken });
    expect(r.ok).toBe(false);
  });
});
