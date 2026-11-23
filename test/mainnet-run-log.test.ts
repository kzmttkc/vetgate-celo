import { describe, it, expect } from "vitest";

import {
  isDailyPaymentDoneUtc,
  isStepDone,
  utcDayStamp,
} from "../src/mainnet-run-log.js";

const SAMPLE_LOG = `# Celo mainnet

| Step | Tx hash | Note | UTC |
|---|---|---|---|
| deploy_pay_guard | \`0xabc\` | ok | 2026-01-01T00:00:00.000Z |
| daily_small_use | \`0xdef\` | daily ALLOW utc=2026-11-23 | 2026-11-23T12:00:00.000Z |
`;

describe("MAINNET_RUN.md idempotency", () => {
  it("detects completed steps with real hashes", () => {
    expect(isStepDone("deploy_pay_guard", SAMPLE_LOG)).toBe(true);
    expect(isStepDone("altana_wallet_and_session", SAMPLE_LOG)).toBe(false);
  });

  it("detects daily UTC idempotency", () => {
    expect(isDailyPaymentDoneUtc("2026-11-23", SAMPLE_LOG)).toBe(true);
    expect(isDailyPaymentDoneUtc("2026-11-24", SAMPLE_LOG)).toBe(false);
  });

  it("utcDayStamp is YYYY-MM-DD", () => {
    expect(utcDayStamp(new Date("2026-11-23T23:59:00.000Z"))).toBe("2026-11-23");
  });
});