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
| demo_block_revert | \`0xrevert\` | stale relay row (superseded: relay path did not land on chain) | 2026-11-23T11:43:15.368Z |
| demo_block_revert | \`0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210\` | BLOCK on chain | 2026-11-23T12:01:00.000Z |
`;

describe("MAINNET_RUN.md idempotency", () => {
  it("detects completed steps with real hashes", () => {
    expect(isStepDone("deploy_pay_guard", SAMPLE_LOG)).toBe(true);
    expect(isStepDone("altana_wallet_and_session", SAMPLE_LOG)).toBe(false);
    expect(isStepDone("demo_block_revert", SAMPLE_LOG)).toBe(true);
  });

  it("ignores superseded 0xrevert placeholder rows", () => {
    const onlyStale = `# log
| Step | Tx hash | Note | UTC |
|---|---|---|---|
| demo_block_revert | \`0xrevert\` | stale (superseded: relay path did not land on chain) | t |
`;
    expect(isStepDone("demo_block_revert", onlyStale)).toBe(false);
  });

  it("detects daily UTC idempotency", () => {
    expect(isDailyPaymentDoneUtc("2026-11-23", SAMPLE_LOG)).toBe(true);
    expect(isDailyPaymentDoneUtc("2026-11-24", SAMPLE_LOG)).toBe(false);
  });

  it("treats skipped-not-ALLOW rows as done for that UTC day", () => {
    const skipped = `${SAMPLE_LOG}| daily_small_use | \`0xskipped\` | skipped: not ALLOW utc=2026-11-24 | 2026-11-24T00:00:00.000Z |\n`;
    expect(isDailyPaymentDoneUtc("2026-11-24", skipped)).toBe(true);
  });

  it("utcDayStamp is YYYY-MM-DD", () => {
    expect(utcDayStamp(new Date("2026-11-23T23:59:00.000Z"))).toBe("2026-11-23");
  });
});