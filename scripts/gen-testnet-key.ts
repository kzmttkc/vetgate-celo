import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";

const dir = join(process.cwd(), ".secrets");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const path = join(dir, "testnet.key");
const pk = generatePrivateKey();
writeFileSync(path, `${pk}\n`, { mode: 0o600 });
chmodSync(path, 0o600);
console.log(`Wrote ${path} (chmod 600). Private key is not printed.`);