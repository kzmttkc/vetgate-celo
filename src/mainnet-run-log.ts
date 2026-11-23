import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import type { MainnetRunStepId } from "./mainnet-runbook.js";

export const MAINNET_RUN_LOG_PATH = join(process.cwd(), "MAINNET_RUN.md");
export const SESSION_KEY_PATH = join(process.cwd(), ".secrets", "session.key");
export const SESSION_META_PATH = join(process.cwd(), ".secrets", "session.json");

/** ERC-8004 agent token already minted to admin on Celo mainnet (step 2 skip). */
export const MAINNET_EXISTING_ERC8004_AGENT_ID = 9907n;

const PLACEHOLDER_HASH = /^(—|_—_|0x0)$/i;

export function readRunLogContents(): string {
  if (!existsSync(MAINNET_RUN_LOG_PATH)) {
    return "";
  }
  return readFileSync(MAINNET_RUN_LOG_PATH, "utf8");
}

/** True when the log table has a real tx hash for this step id. */
export function isStepDone(stepId: MainnetRunStepId, contents = readRunLogContents()): boolean {
  const pattern = new RegExp(`\\|\\s*${stepId}\\s*\\|\\s*\`([^\`]+)\``, "g");
  for (const match of contents.matchAll(pattern)) {
    const hash = match[1]?.trim() ?? "";
    if (hash && !PLACEHOLDER_HASH.test(hash)) {
      return true;
    }
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

export function appendTxRow(
  stepId: MainnetRunStepId,
  hash: string,
  note: string,
): void {
  const line = `| ${stepId} | \`${hash}\` | ${note} | ${new Date().toISOString()} |\n`;
  const contents = readRunLogContents();
  if (!contents.includes("| Step |")) {
    writeFileSync(
      MAINNET_RUN_LOG_PATH,
      `# Celo mainnet run log (42220)\n\n| Step | Tx hash | Note | UTC |\n|---|---|---|---|\n${line}`,
    );
    return;
  }
  appendFileSync(MAINNET_RUN_LOG_PATH, line);
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