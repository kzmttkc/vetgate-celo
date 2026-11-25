import * as esbuild from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_ROOT = ".vercel/output";
const FUNC_DIR = join(OUT_ROOT, "functions", "api.func");
const STATIC_DIR = join(OUT_ROOT, "static");

rmSync(OUT_ROOT, { recursive: true, force: true });
mkdirSync(FUNC_DIR, { recursive: true });
mkdirSync(STATIC_DIR, { recursive: true });

await esbuild.build({
  entryPoints: ["src/vercel-api.ts"],
  outfile: join(FUNC_DIR, "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "bundle",
  banner: {
    js:
      'import { createRequire as __vetgateCreateRequire } from "node:module";' +
      'const require = __vetgateCreateRequire(import.meta.url);',
  },
  logLevel: "info",
});

writeFileSync(
  join(FUNC_DIR, ".vc-config.json"),
  `${JSON.stringify(
    {
      runtime: "nodejs24.x",
      handler: "index.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      shouldAddSourcemapSupport: false,
    },
    null,
    2,
  )}\n`,
);

writeFileSync(
  join(OUT_ROOT, "config.json"),
  `${JSON.stringify(
    {
      version: 3,
      routes: [
        { handle: "filesystem" },
        { src: "/(.*)", dest: "/api" },
      ],
    },
    null,
    2,
  )}\n`,
);