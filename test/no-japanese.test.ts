import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const JAPANESE =
  /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

const TEXT_FILE = /\.(md|ts|mjs|js|json|sol|toml|yaml|yml|example)$/i;

describe("tracked text files", () => {
  it("contain no Japanese characters", () => {
    const tracked = execSync("git ls-files", { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    const offenders: string[] = [];
    for (const rel of tracked) {
      if (!TEXT_FILE.test(rel)) continue;
      const body = readFileSync(rel, "utf8");
      if (JAPANESE.test(body)) offenders.push(rel);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});