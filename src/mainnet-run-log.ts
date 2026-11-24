import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MainnetRunStepId } from "./mainnet-runbook.js";

export const MAINNET_RUN_LOG_PATH = join(process.cwd(), "MAINNET_RUN.md");
export const SESSION_KEY_PATH = join(process.cwd(), ".secrets", "session.key");
export const SESSION_META_PATH = join(process.cwd(), ".secrets", "session.json");

/** ERC-8004 agent token already minted to admin on Celo mainnet (step 2 skip). */
export const MAINNET_EXISTING_ERC8004_AGENT_ID = 9907n;

const PLACEHOLDER_HASH = /^(—|_—_|0x0|0xrevert)$/i;

/** Logged when a runbook step is intentionally skipped (no on-chain tx). */
export const TX_SKIP_RECORDED_MARKER = "skipped";

const TABLE_APPEND_SENTENCE =
  "Each successful `scripts/mainnet-run.ts` run appends a row to this table.";

function rowForStep(stepId: MainnetRunStepId, contents: string): string[] {
  return contents
    .split("\n")
    .filter((line) => line.includes(`| ${stepId} |`) && line.trimStart().startsWith("|"));
}

export function markTxRowSuperseded(stepId: MainnetRunStepId, hash: string, reason: string): void {
  let contents = readRunLogContents();
  const rows = rowForStep(stepId, contents);
  for (const row of rows) {
    if (!row.includes(`\`${hash}\``)) continue;
    if (/superseded/i.test(row)) continue;
    const parts = row.split("|").map((p) => p.trim());
    if (parts.length >= 4) {
      parts[3] = `${parts[3]} (superseded: ${reason})`;
    }
    const updated = `| ${parts.slice(1, -1).join(" | ")} |`;
    contents = contents.replace(row, updated);
  }
  writeFileSync(MAINNET_RUN_LOG_PATH, contents);
}

export function readRunLogContents(): string {
  if (!existsSync(MAINNET_RUN_LOG_PATH)) {
    return "";
  }
  return readFileSync(MAINNET_RUN_LOG_PATH, "utf8");
}

/** True when the log table has a real tx hash for this step id. */
export function isStepDone(stepId: MainnetRunStepId, contents = readRunLogContents()): boolean {
  for (const row of rowForStep(stepId, contents)) {
    if (/superseded/i.test(row)) continue;
    const hashMatch = row.match(/\|\s*[^|]+\s*\|\s*`([^`]+)`/);
    const hash = hashMatch?.[1]?.trim() ?? "";
    if (!hash) continue;
    if (hash === TX_SKIP_RECORDED_MARKER) return true;
    if (!PLACEHOLDER_HASH.test(hash)) return true;
  }
  return false;
}

export function assertStepNotDone(stepId: MainnetRunStepId): void {
  if (isStepDone(stepId)) {
    throw new Error(`${stepId}: refused — already recorded in MAINNET_RUN.md`);
  }
}

export function readRunMetadata(key: string, contents = readRunLogContents()): string | undefined {
  const re = new RegExp("^-\\s*" + key + ":\\s*`?([^`\\n]+)`?\\s*$", "m");
  const m = contents.match(re);
  return m?.[1]?.trim();
}

export function upsertRunMetadata(key: string, value: string): void {
  let contents = readRunLogContents();
  const line = `- ${key}: \`${value}\``;
  if (contents.includes("## Run state")) {
    const blockRe = new RegExp(`^-\\s*${key}:\\s*.+$`, "m");
    if (blockRe.test(contents)) {
      contents = contents.replace(blockRe, line);
    } else {
      contents = contents.replace("## Run state\n", `## Run state\n${line}\n`);
    }
  } else {
    contents = `${contents.trimEnd()}\n\n## Run state\n${line}\n`;
  }
  writeFileSync(MAINNET_RUN_LOG_PATH, contents);
}

/** Insert a new table row after the last `|` line in the tx table, before the append sentence or run state. */
export function insertTxRowLine(contents: string, line: string): string {
  const sentenceIdx = contents.indexOf(TABLE_APPEND_SENTENCE);
  const splitAt =
    sentenceIdx >= 0
      ? sentenceIdx
      : contents.includes("\n## Run state\n")
        ? contents.indexOf("\n## Run state\n")
        : contents.length;
  const before = contents.slice(0, splitAt);
  const after = contents.slice(splitAt);
  const lines = before.split("\n");
  let lastPipeLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith("|")) lastPipeLine = i;
  }
  if (lastPipeLine < 0) {
    return `${before.trimEnd()}\n${line}\n${after}`;
  }
  lines.splice(lastPipeLine + 1, 0, line);
  return `${lines.join("\n")}${after}`;
}

export function appendTxRow(
  stepId: MainnetRunStepId,
  hash: string,
  note: string,
): void {
  const line = `| ${stepId} | \`${hash}\` | ${note} | ${new Date().toISOString()} |`;
  let contents = readRunLogContents();
  if (!contents.includes("| Step |")) {
    writeFileSync(
      MAINNET_RUN_LOG_PATH,
      `# Celo mainnet run log (42220)\n\n| Step | Tx hash | Note | UTC |\n|---|---|---|---|\n${line}\n`,
    );
    return;
  }
  contents = insertTxRowLine(contents, line);
  writeFileSync(MAINNET_RUN_LOG_PATH, contents);
}

/** UTC calendar day already has a completed daily_small_use row. */
export function isDailyPaymentDoneUtc(utcDay: string, contents = readRunLogContents()): boolean {
  const needle = `daily_small_use`;
  if (!contents.includes(needle)) return false;
  const rows = contents.split("\n").filter((l) => l.includes(`| ${needle} |`));
  return rows.some((row) => row.includes(utcDay));
}

export function utcDayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}