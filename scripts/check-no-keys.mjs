#!/usr/bin/env node
/**
 * Scan tracked files and git history for private key material matching .secrets/*.key.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const KEY_PATTERN = /\b0x[0-9a-fA-F]{64}\b/g;
const violations = [];

function normalizeHex(raw) {
  return raw.slice(2).toLowerCase();
}

function loadSecretFingerprints() {
  const dir = join(ROOT, ".secrets");
  const fingerprints = new Set();
  if (!existsSync(dir)) return fingerprints;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".key")) continue;
    const body = readFileSync(join(dir, name), "utf8").trim();
    if (/^0x[0-9a-fA-F]{64}$/.test(body)) {
      fingerprints.add(normalizeHex(body));
    }
  }
  return fingerprints;
}

const secretPrints = loadSecretFingerprints();

function scanText(rel, text) {
  const hexMatches = text.match(KEY_PATTERN) ?? [];
  for (const hex of hexMatches) {
    const norm = normalizeHex(hex);
    if (secretPrints.has(norm)) {
      violations.push(`${rel}: matches a .secrets key fingerprint`);
      return;
    }
    if (rel.endsWith(".md") && text.includes(`\`${hex}\``)) continue;
    if (rel.includes("check-no-keys")) continue;
    violations.push(`${rel}: looks like a raw secp256k1 private key`);
  }
}

const tracked = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

for (const rel of tracked) {
  if (rel.startsWith(".secrets/")) {
    violations.push(`${rel}: secrets must not be tracked by git`);
    continue;
  }
  const abs = join(ROOT, rel);
  try {
    scanText(rel, readFileSync(abs, "utf8"));
  } catch {
    /* skip */
  }
}

try {
  const history = execSync("git log -p --all", {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  for (const hex of history.match(KEY_PATTERN) ?? []) {
    if (secretPrints.has(normalizeHex(hex))) {
      violations.push("git-history: patch contains a .secrets key fingerprint");
      break;
    }
  }
} catch {
  /* empty history */
}

if (violations.length > 0) {
  console.error("check-no-keys: FAILED");
  for (const v of [...new Set(violations)]) console.error(`  - ${v}`);
  process.exit(1);
}

console.log(`check-no-keys: OK (${tracked.length} tracked files)`);