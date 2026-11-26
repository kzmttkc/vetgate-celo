import request from "supertest";
import { describe, it, expect } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../src/app.js";
import {
  OnchainStats,
  type GuardedPaymentLog,
  type OnchainReader,
} from "../src/onchain-stats.js";

const TEAM = "0x970b37B3C58eDc62Cccb7BeeaB5972bC7c6b0435";
const OTHER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER2 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
const USDT = "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e";
const PAYTO = "0x20faaca5f980e29639a0fcc6dca6988e18ed333b";

function log(buyer: string, token: string, amount: bigint, blockNumber: bigint): GuardedPaymentLog {
  return { buyer, payTo: PAYTO, token, amount, blockNumber };
}

/** Fake RPC that enforces forno's 5000-block window and records calls. */
function fakeReader(head: { value: bigint }, logs: GuardedPaymentLog[], failAt?: bigint) {
  const calls: Array<[bigint, bigint]> = [];
  const reader: OnchainReader = {
    getBlockNumber: async () => head.value,
    getGuardedPaymentLogs: async (from, to) => {
      calls.push([from, to]);
      if (to - from >= 5000n) throw new Error("max block range 5000");
      if (failAt !== undefined && from <= failAt && failAt <= to) throw new Error("rpc down");
      return logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to);
    },
  };
  return { reader, calls };
}

describe("OnchainStats", () => {
  const logs = [
    log(TEAM, USDC, 1000n, 100n),
    log(TEAM.toLowerCase(), USDC, 2000n, 6000n),
    log(OTHER, USDC, 5000n, 12_000n),
    log(OTHER2, USDT, 7n, 12_001n),
    log(OTHER, USDC, 1n, 14_999n),
  ];

  it("counts payments, raw amounts per token, distinct payers and team/independent split", async () => {
    const head = { value: 15_000n };
    const { reader, calls } = fakeReader(head, logs);
    const s = new OnchainStats({
      reader,
      teamWallets: new Set([TEAM.toLowerCase()]),
      fromBlock: 100n,
      now: () => Date.parse("2026-11-26T00:00:00Z"),
    });
    const snap = await s.snapshot();
    if ("error" in snap) throw new Error("unexpected error");
    expect(snap.payments).toBe(5);
    expect(snap.payers).toBe(3);
    expect(snap.amount).toEqual({ [USDC.toLowerCase()]: "8001", [USDT]: "7" });
    expect(snap.team).toEqual({ payments: 2, amount: { [USDC.toLowerCase()]: "3000" }, payers: 1 });
    expect(snap.independent).toEqual({
      payments: 3,
      amount: { [USDC.toLowerCase()]: "5001", [USDT]: "7" },
      payers: 2,
    });
    expect(snap.fromBlock).toBe("100");
    expect(snap.toBlock).toBe("15000");
    expect(snap.asOf).toBe("2026-11-26T00:00:00.000Z");
    // 100..15000 split into windows of <= 5000 blocks, contiguous and complete
    expect(calls.length).toBe(3);
    expect(calls[0]).toEqual([100n, 5099n]);
    expect(calls[calls.length - 1]![1]).toBe(15_000n);
  });

  it("caches for the TTL, then reads only the new blocks", async () => {
    let t = 0;
    const head = { value: 15_000n };
    const all = [...logs];
    const { reader, calls } = fakeReader(head, all);
    const s = new OnchainStats({ reader, teamWallets: new Set(), fromBlock: 100n, now: () => t });
    await s.snapshot();
    const n = calls.length;
    t = 59_999;
    await s.snapshot();
    expect(calls.length).toBe(n);
    all.push(log(OTHER, USDC, 9n, 15_500n));
    head.value = 16_000n;
    t = 60_000;
    const snap = await s.snapshot();
    expect(calls.slice(n)).toEqual([[15_001n, 16_000n]]);
    if ("error" in snap) throw new Error("unexpected error");
    expect(snap.payments).toBe(6);
    expect(snap.toBlock).toBe("16000");
  });

  it("returns rpc_unavailable (not zeros) when any chunk fails", async () => {
    const head = { value: 15_000n };
    const { reader } = fakeReader(head, logs, 12_000n);
    const s = new OnchainStats({ reader, teamWallets: new Set(), fromBlock: 100n });
    expect(await s.snapshot()).toEqual({ error: "rpc_unavailable" });
  });

  it("returns rpc_unavailable when the head block cannot be read", async () => {
    const reader: OnchainReader = {
      getBlockNumber: async () => {
        throw new Error("fetch failed");
      },
      getGuardedPaymentLogs: async () => [],
    };
    const s = new OnchainStats({ reader, teamWallets: new Set() });
    expect(await s.snapshot()).toEqual({ error: "rpc_unavailable" });
  });

  it("/v1/stats keeps stats and adds onchain", async () => {
    const pk = generatePrivateKey();
    const { reader } = fakeReader({ value: 15_000n }, logs);
    const app = createApp({
      payTo: privateKeyToAccount(pk).address,
      payGuardAddress: "0x00000000000000000000000000000000000000aa",
      oraclePrivateKey: pk,
      onchainStats: new OnchainStats({ reader, teamWallets: new Set([TEAM.toLowerCase()]), fromBlock: 100n }),
    });
    const res = await request(app).get("/v1/stats");
    expect(res.status).toBe(200);
    expect(res.body.stats.total).toEqual({ free: 0, paid: 0 });
    expect(res.body.onchain.payments).toBe(5);
    expect(res.body.onchain.team.payments).toBe(2);
    expect(res.body.onchain.independent.payments).toBe(3);
  });

  it("/v1/stats returns onchain.error when the RPC is down", async () => {
    const pk = generatePrivateKey();
    const reader: OnchainReader = {
      getBlockNumber: async () => {
        throw new Error("fetch failed");
      },
      getGuardedPaymentLogs: async () => [],
    };
    const app = createApp({
      payTo: privateKeyToAccount(pk).address,
      payGuardAddress: "0x00000000000000000000000000000000000000aa",
      oraclePrivateKey: pk,
      onchainStats: new OnchainStats({ reader, teamWallets: new Set() }),
    });
    const res = await request(app).get("/v1/stats");
    expect(res.status).toBe(200);
    expect(res.body.onchain).toEqual({ error: "rpc_unavailable" });
    expect(res.body.stats).toBeDefined();
  });
});
