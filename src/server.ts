import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app.js";

function loadOracleKey(): `0x${string}` | undefined {
  if (process.env.VETGATE_ORACLE_SIGNER_PK) {
    return process.env.VETGATE_ORACLE_SIGNER_PK as `0x${string}`;
  }
  const file = join(process.cwd(), ".secrets", "testnet.key");
  if (existsSync(file)) {
    return readFileSync(file, "utf8").trim() as `0x${string}`;
  }
  return undefined;
}

const oraclePk = loadOracleKey();
if (!oraclePk) {
  console.error(
    "Missing oracle key: set VETGATE_ORACLE_SIGNER_PK or run npm run gen-testnet-key",
  );
  process.exit(1);
}

const payTo = (process.env.VETGATE_PAYTO_ADDRESS ?? "0x0000000000000000000000000000000000000001") as `0x${string}`;
const payGuard = (process.env.VETGATE_PAY_GUARD_ADDRESS ??
  "0x0000000000000000000000000000000000000001") as `0x${string}`;

const app = createApp({
  payTo,
  payGuardAddress: payGuard,
  oraclePrivateKey: oraclePk,
  teamWalletsCsv: process.env.VETGATE_TEAM_WALLETS,
  x402ApiKey: process.env.X402_API_KEY,
  facilitatorUrl: process.env.CELO_FACILITATOR_URL,
  enableX402: Boolean(process.env.X402_API_KEY),
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`VetGate oracle listening on :${port} (Celo Sepolia ${11142220} only)`);
});