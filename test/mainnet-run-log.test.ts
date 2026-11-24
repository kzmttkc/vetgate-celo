import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, it, expect } from "vitest";

import {
  insertTxRowLine,
  isDailyPaymentDoneUtc,
  isStepDone,
  TX_SKIP_RECORDED_MARKER,
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

  it("utcDayStamp is YYYY-MM-DD", () => {
    expect(utcDayStamp(new Date("2026-11-23T23:59:00.000Z"))).toBe("2026-11-23");
  });

  it("treats skipped marker as done without fake tx hash", () => {
    const log = `# log
| Step | Tx hash | Note | UTC |
|---|---|---|---|
| register_erc8004_seller | \`${TX_SKIP_RECORDED_MARKER}\` | skip: already 9907 | t |
`;
    expect(isStepDone("register_erc8004_seller", log)).toBe(true);
    expect(log).not.toMatch(/0x[0-9a-f]{64}/i);
  });
});

const FIXTURE_WITH_SENTENCE = `# log

| Step | Tx hash | Note | UTC |
|---|---|---|---|
| deploy_pay_guard | \`0xabc\` | ok | t |

Each successful \`scripts/mainnet-run.ts\` run appends a row to this table.

## Run state

- pay_guard: \`0x1\`
`;

describe("appendTxRow placement", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("inserts after last table row and before the append sentence", () => {
    const newLine = "| altana_wallet_and_session | `0xnew` | note | 2026-01-01T00:00:00.000Z |";
    const out = insertTxRowLine(FIXTURE_WITH_SENTENCE, newLine);
    const lines = out.split("\n");
    const pipeLines = lines
      .map((l, i) => ({ i, l }))
      .filter(({ l }) => l.trimStart().startsWith("|"))
      .map(({ l }) => l);
    expect(pipeLines.at(-1)).toBe(newLine);
    const lastPipeIdx = lines.findLastIndex((l) => l.trimStart().startsWith("|"));
    expect(lines[lastPipeIdx + 1]).toBe("");
    expect(lines[lastPipeIdx + 2]).toBe(
      "Each successful `scripts/mainnet-run.ts` run appends a row to this table.",
    );
    const runStateIdx = lines.findIndex((l) => l === "## Run state");
    const sentenceIdx = lines.findIndex((l) =>
      l.includes("Each successful `scripts/mainnet-run.ts`"),
    );
    expect(sentenceIdx).toBeGreaterThan(lastPipeIdx);
    expect(runStateIdx).toBeGreaterThan(sentenceIdx);
  });

  it("keeps MAINNET_RUN.md table contiguous when appending in a temp copy", () => {
    const repoRoot = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "vetgate-run-log-"));
    const src = join(repoRoot, "MAINNET_RUN.md");
    if (!existsSync(src)) return;
    const newLine =
      "| deploy_pay_guard | `0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210` | test contiguous | 2099-01-01T00:00:00.000Z |";
    const original = readFileSync(src, "utf8");
    const contents = insertTxRowLine(original, newLine);
    writeFileSync(join(tempDir, "MAINNET_RUN.md"), contents);
    const betweenTableAndRunState = contents.split("## Run state")[0] ?? "";
    const tableLines = betweenTableAndRunState
      .split("\n")
      .filter((l) => l.trimStart().startsWith("|"));
    const sentenceLine = "Each successful `scripts/mainnet-run.ts` run appends a row to this table.";
    const tableBlock = tableLines.join("\n");
    const afterTable = betweenTableAndRunState.slice(
      betweenTableAndRunState.indexOf(tableLines.at(-1) ?? "") +
        (tableLines.at(-1)?.length ?? 0),
    );
    expect(afterTable.trimStart().startsWith(sentenceLine)).toBe(true);
    expect(tableBlock).not.toContain("## Run state");
    expect(tableLines.at(-1)).toContain("test contiguous");
  });
});