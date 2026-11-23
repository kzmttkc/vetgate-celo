import { createRequire } from "node:module";
import { join } from "node:path";

const nodeRequire = createRequire(import.meta.url);

export function loadRelayModuleForTests() {
  return nodeRequire(
    join(process.cwd(), "node_modules/@altananetwork/sdk/dist/internal/relay.js"),
  ) as {
    buildRelayClient: (network: unknown) => { dataSuffix?: unknown };
  };
}