#!/usr/bin/env npx tsx
/**
 * Local VetGate demo: verified agent A gets free tier, second agent B (same human) gets 402.
 * Self verification on Celo Sepolia (testnet); PayGuard usedNonces read on Celo mainnet (RPC read only).
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SelfAgent } from "@selfxyz/agent-sdk";
import { createPublicClient, http } from "viem";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";

import { createApp } from "../src/app.js";
import {
  CELO_MAINNET_RPC,
  resolveCeloRuntime,
} from "../src/chain.js";
import { loadOracleKey } from "../src/oracle-bootstrap.js";

export const MAINNET_PAY_GUARD_ADDRESS =
  "0xde00a2f23792e3cadbf0088a1b93276748a5666c" as const;

const DEFAULT_AGENT_A_KEY = ".self/agent-a.key";
const DEFAULT_AGENT_B_KEY = ".self/agent-b.key";

const PAY_GUARD_USED_NONCES_ABI = [
  {
    type: "function",
    name: "usedNonces",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;

export const MISSING_AGENT_KEYS_MESSAGE =
  "Need Celo Sepolia mock-passport keys at .self/agent-a.key and .self/agent-b.key (self-agent register export --out-key), or set VETGATE_AGENT_A_KEY_FILE / VETGATE_AGENT_B_KEY_FILE.";

const SELLER_URL = "https://gateway.usebuy.ai/v1/social/tiktok/profile";
const BUYER = "0xCDb0FF6e6Dfc33F9d75288772c8EfFaa13df9941" as const;

export type AgentKeyPaths = { agentAKeyFile: string; agentBKeyFile: string };

/** CLI args / env for agent key paths (self-agent export --out-key format: hex private key). */
export function resolveAgentKeyPaths(argv = process.argv.slice(2)): AgentKeyPaths {
  let agentAKeyFile =
    process.env.VETGATE_AGENT_A_KEY_FILE ?? DEFAULT_AGENT_A_KEY;
  let agentBKeyFile =
    process.env.VETGATE_AGENT_B_KEY_FILE ?? DEFAULT_AGENT_B_KEY;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--agent-a-key" && argv[i + 1]) {
      agentAKeyFile = argv[++i];
    } else if (argv[i] === "--agent-b-key" && argv[i + 1]) {
      agentBKeyFile = argv[++i];
    }
  }

  const cwd = process.cwd();
  return {
    agentAKeyFile: join(cwd, agentAKeyFile),
    agentBKeyFile: join(cwd, agentBKeyFile),
  };
}

export function agentKeyFilesPresent(paths: AgentKeyPaths): boolean {
  return existsSync(paths.agentAKeyFile) && existsSync(paths.agentBKeyFile);
}

/**
 * Mainnet PayGuard.usedNonces reader — does not use CELO_RPC_URL (Sepolia Self + signing stay on testnet RPC).
 * {@link resolveCeloRuntime} maps CELO_RPC_URL to both SelfAgent.rpcUrl and readPayGuardNonceUsed; overriding it
 * for mainnet reads would break testnet Self agent signing, so createApp gets this via readPayGuardNonceUsed.
 */
export function createMainnetPayGuardNonceReader(
  payGuardAddress: `0x${string}` = MAINNET_PAY_GUARD_ADDRESS,
  rpcUrl = process.env.VETGATE_MAINNET_RPC_URL ?? CELO_MAINNET_RPC,
): (payGuard: `0x${string}`, nonce: `0x${string}`) => Promise<boolean> {
  const client = createPublicClient({
    transport: http(rpcUrl),
  });
  return async (payGuard, nonce) =>
    client.readContract({
      address: payGuardAddress,
      abi: PAY_GUARD_USED_NONCES_ABI,
      functionName: "usedNonces",
      args: [nonce],
    });
}

export function formatDemoLine(
  step: number,
  status: number,
  summary: string,
): string {
  return `(${step}) ${summary} → HTTP ${status}`;
}

function readAgentPrivateKey(path: string): `0x${string}` {
  return readFileSync(path, "utf8").trim() as `0x${string}`;
}

function buildPermitUrl(
  baseUrl: string,
  payTo: `0x${string}`,
): string {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/v1/permit`);
  url.searchParams.set("payTo", payTo);
  url.searchParams.set("buyer", BUYER);
  url.searchParams.set("sellerUrl", SELLER_URL);
  url.searchParams.set("maxAmount", "1000000");
  return url.toString();
}

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
    server.on("error", reject);
  });
}

async function main(): Promise<void> {
  process.env.VETGATE_CELO_NETWORK =
    process.env.VETGATE_CELO_NETWORK ?? process.env.VETGATE_NETWORK ?? "testnet";

  const keyPaths = resolveAgentKeyPaths();
  if (!agentKeyFilesPresent(keyPaths)) {
    console.log(MISSING_AGENT_KEYS_MESSAGE);
    process.exit(2);
  }

  const oraclePk = loadOracleKey();
  if (!oraclePk) {
    throw new Error(
      "Missing oracle key for local VetGate (VETGATE_ORACLE_SIGNER_PK or .secrets/testnet.key).",
    );
  }

  const celo = resolveCeloRuntime();
  if (celo.network !== "testnet") {
    throw new Error("This demo requires VETGATE_CELO_NETWORK=testnet (Celo Sepolia mock passport agents).");
  }

  const payTo = (process.env.VETGATE_PAYTO_ADDRESS ??
    privateKeyToAccount(oraclePk).address) as `0x${string}`;
  const payGuard = (process.env.VETGATE_PAY_GUARD_ADDRESS ??
    MAINNET_PAY_GUARD_ADDRESS) as `0x${string}`;

  const app = createApp({
    payTo,
    payGuardAddress: payGuard,
    oraclePrivateKey: oraclePk,
    enableX402: false,
    readPayGuardNonceUsed: createMainnetPayGuardNonceReader(payGuard),
  });

  const { server, baseUrl } = await listen(app);
  const permitUrl = buildPermitUrl(baseUrl, payTo);

  try {
    const unsigned = await fetch(permitUrl);
    const noSigBody = (await unsigned.json().catch(() => ({}))) as {
      error?: string;
    };
    console.log(
      formatDemoLine(
        1,
        unsigned.status,
        `no Self signature (${noSigBody.error ?? "self_agent_required"})`,
      ),
    );

    const agentAPk = readAgentPrivateKey(keyPaths.agentAKeyFile);
    const selfA = new SelfAgent({
      privateKey: agentAPk,
      network: celo.selfNetwork,
      rpcUrl: celo.rpc,
    });
    const resA = await selfA.fetch(permitUrl);
    const bodyA = (await resA.json().catch(() => ({}))) as {
      tier?: string;
      freeQuota?: { key?: string };
    };
    const keyA = bodyA.freeQuota?.key;
    console.log(
      formatDemoLine(
        2,
        resA.status,
        `agent-a tier=${bodyA.tier ?? "?"}${keyA ? ` freeQuota.key=${keyA}` : ""}`,
      ),
    );

    const agentBPk = readAgentPrivateKey(keyPaths.agentBKeyFile);
    const selfB = new SelfAgent({
      privateKey: agentBPk,
      network: celo.selfNetwork,
      rpcUrl: celo.rpc,
    });
    const resB = await selfB.fetch(permitUrl);
    const bodyB = (await resB.json().catch(() => ({}))) as {
      error?: string;
      freeQuota?: { key?: string; used?: boolean };
    };
    const keyB = bodyB.freeQuota?.key;
    const sameKey =
      keyA && keyB && keyA === keyB ? " freeQuota.key same as step (2)" : "";
    console.log(
      formatDemoLine(
        3,
        resB.status,
        `agent-b ${bodyB.error ?? "ok"}${keyB ? ` freeQuota.key=${keyB}` : ""}${sameKey}`,
      ),
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

const entryPath = fileURLToPath(import.meta.url);
const invokedAsMain =
  process.argv[1] !== undefined &&
  (process.argv[1] === entryPath || process.argv[1].endsWith("two-agent-demo.ts"));

if (invokedAsMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}