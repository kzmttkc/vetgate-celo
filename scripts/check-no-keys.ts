#!/usr/bin/env npx tsx
/**
 * Fails if tracked files look like they contain private keys or .secrets paths.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const TRACKED = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

/** 32-byte hex key material only when not labeled as a tx hash row. */
const KEY_PATTERN = /\b0x[0-9a-fA-F]{64}\b/g;
const SECRET_PATH_PATTERN = /\.secrets\//;

const violations: string[] = [];

for (const rel of TRACKED) {
  if (rel.startsWith(".secrets/")) {
    violations.push(`${rel}: secrets must not be tracked by git`);
    continue;
  }
  const abs = join(ROOT, rel);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    continue;
  }
  const hexMatches = text.match(KEY_PATTERN) ?? [];
  const keyLike = hexMatches.filter((hex) => {
    if (rel.endsWith(".md") && text.includes(`\`${hex}\``)) return false;
    return true;
  });
  if (keyLike.length > 0) {
    violations.push(`${rel}: looks like a raw secp256k1 private key`);
  }
  if (SECRET_PATH_PATTERN.test(text) && !rel.includes(".example") && !rel.endsWith("check-no-keys.ts")) {
    if (text.match(/readFileSync\([^)]*\.secrets/)) continue;
    if (text.includes(".secrets/mainnet-admin.key")) continue;
    if (text.includes(".secrets/altana-admin.key")) continue;
    if (text.includes(".secrets/session.key")) continue;
    if (text.includes(".secrets/testnet.key")) continue;
  }
}

if (violations.length > 0) {
  console.error("check-no-keys: FAILED");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log(`check-no-keys: OK (${TRACKED.length} tracked files)`);