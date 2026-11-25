import * as esbuild from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("public", { recursive: true });
writeFileSync("public/.gitkeep", "");

await esbuild.build({
  entryPoints: ["src/vercel-api.ts"],
  outfile: "api/index.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "bundle",
  banner: {
    js:
      'import { createRequire as __vetgateCreateRequire } from "node:module";' +
      'const require = __vetgateCreateRequire(import.meta.url);',
  },
  logLevel: "info",
});