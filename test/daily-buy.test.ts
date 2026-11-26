import { describe, it, expect } from "vitest";

import { CELO_MAINNET_USDC } from "../src/chain.js";
import { dailyBuySpentUnits, isDailyBuyDoneUtc } from "../src/mainnet-run-log.js";
import {
  DAILY_BUY_MAX_UNITS,
  DAILY_BUY_TOTAL_CAP_UNITS,
  assertDailyBuyBudget,
  runDailyBuy,
} from "../src/x402-buy-once.js";

const SELLER_PAYTO = "0x20faaca5f980e29639a0fcc6dca6988e18ed333b";
const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;

const LOG = [
  "| Step | Tx hash | Note | UTC |",
  "|---|---|---|---|",
  `| daily_small_use | \`${HASH_A}\` | ALLOW payWithPermit | 2026-11-27T01:01:00.000Z |`,
  `| daily_buy | \`${HASH_A}\` | x402 after vet402 ALLOW utc=2026-11-27 units=5000 | 2026-11-27T01:02:00.000Z |`,
  `| daily_buy | \`${HASH_B}\` | x402 after vet402 ALLOW utc=2026-11-28 units=5000 | 2026-11-28T01:02:00.000Z |`,
  "| daily_buy | `skipped` | not ALLOW utc=2026-11-29 units=5000 | 2026-11-29T01:02:00.000Z |",
].join("\n");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(opts: { verdict: string; quotePayTo?: string; amount?: string }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("vet402.com/api/v1/check")) {
      return json({
        recommendation: opts.verdict,
        verified_pay_to_by_network: [{ network: "eip155:42220", payTo: SELLER_PAYTO }],
      });
    }
    if (url.includes("gateway.usebuy.ai")) {
      return json(
        {
          x402Version: 1,
          accepts: [
            {
              scheme: "exact",
              network: "celo",
              maxAmountRequired: opts.amount ?? "5000",
              payTo: opts.quotePayTo ?? SELLER_PAYTO,
              asset: CELO_MAINNET_USDC,
              extra: { name: "USDC", version: "2" },
            },
          ],
        },
        402,
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

describe("daily buy", () => {
  it("counts only daily_buy rows with a real tx hash", () => {
    expect(dailyBuySpentUnits(LOG)).toBe(10_000n);
  });

  it("treats a recorded day as done, including a recorded skip", () => {
    expect(isDailyBuyDoneUtc("2026-11-27", LOG)).toBe(true);
    expect(isDailyBuyDoneUtc("2026-11-29", LOG)).toBe(true);
    expect(isDailyBuyDoneUtc("2026-11-30", LOG)).toBe(false);
  });

  it("refuses a price above 0.005 USDC and a total above 0.1 USDC", () => {
    expect(() => assertDailyBuyBudget(DAILY_BUY_MAX_UNITS + 1n, 0n)).toThrow(/refused/);
    expect(() => assertDailyBuyBudget(5_000n, DAILY_BUY_TOTAL_CAP_UNITS - 4_999n)).toThrow(/refused/);
    expect(() => assertDailyBuyBudget(5_000n, DAILY_BUY_TOTAL_CAP_UNITS - 5_000n)).not.toThrow();
  });

  const future = new Date("2099-01-01T00:00:00Z");

  it("does not buy when vet402 does not return ALLOW", async () => {
    const r = await runDailyBuy({ live: false, fetchImpl: mockFetch({ verdict: "WARN" }), now: future });
    expect(r).toEqual({ mode: "skip", reason: "not ALLOW", day: "2099-01-01" });
  });

  it("refuses when the 402 payTo differs from the payTo vet402 vouched for", async () => {
    await expect(
      runDailyBuy({
        live: false,
        fetchImpl: mockFetch({ verdict: "ALLOW", quotePayTo: `0x${"1".repeat(40)}` }),
        now: future,
      }),
    ).rejects.toThrow(/differs/);
  });

  it("refuses a quote above the daily price cap", async () => {
    await expect(
      runDailyBuy({ live: false, fetchImpl: mockFetch({ verdict: "ALLOW", amount: "6000" }), now: future }),
    ).rejects.toThrow(/refused/);
  });

  it("quotes on ALLOW in dry mode without paying", async () => {
    const r = await runDailyBuy({ live: false, fetchImpl: mockFetch({ verdict: "ALLOW" }), now: future });
    expect(r.mode).toBe("dry");
    if (r.mode === "dry") expect(r.units).toBe(5_000n);
  });
});
