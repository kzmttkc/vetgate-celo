import { createPublicClient, http, parseAbi, recoverMessageAddress, type Address, type Hex } from "viem";

/** Request headers for the ERC-8004 path (an agent without a Self Agent ID). */
export const ERC8004_HEADERS = {
  AGENT_ID: "x-erc8004-agent-id",
  SIGNATURE: "x-erc8004-signature",
  TIMESTAMP: "x-erc8004-timestamp",
} as const;

/** ERC-8004 identity registry on Celo mainnet. */
export const CELO_ERC8004_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;
export const ERC8004_MAX_SKEW_SECONDS = 300;

export type Erc8004Agent = { agentId: bigint; address: Address };
export type Erc8004Reader = {
  ownerOf(agentId: bigint): Promise<Address | null>;
  agentWallet(agentId: bigint): Promise<Address | null>;
};

/** The exact text the agent signs with EIP-191 (personal_sign). */
export function erc8004RequestMessage(method: string, originalUrl: string, timestamp: string, agentId: string): string {
  return `VetGate ERC-8004 request\nagent: ${agentId}\n${method.toUpperCase()} ${originalUrl}\nts: ${timestamp}`;
}

export type Erc8004Result =
  | { ok: true; agent: Erc8004Agent }
  | { ok: false; status: 401 | 403; error: string; message: string };

export async function verifyErc8004Request(params: {
  method: string;
  originalUrl: string;
  agentIdHeader: string;
  signature: string;
  timestamp: string;
  reader: Erc8004Reader;
  nowSeconds?: number;
}): Promise<Erc8004Result> {
  const bad = (status: 401 | 403, error: string, message: string): Erc8004Result => ({ ok: false, status, error, message });
  if (!/^\d{1,30}$/.test(params.agentIdHeader)) return bad(401, "erc8004_invalid", "x-erc8004-agent-id must be a decimal agent id.");
  if (!/^\d{1,13}$/.test(params.timestamp)) return bad(401, "erc8004_invalid", "x-erc8004-timestamp must be unix seconds.");
  if (!/^0x[0-9a-fA-F]{130}$/.test(params.signature)) return bad(401, "erc8004_invalid", "x-erc8004-signature must be a 65-byte hex signature.");
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(params.timestamp)) > ERC8004_MAX_SKEW_SECONDS) {
    return bad(401, "erc8004_stale", `Timestamp must be within ${ERC8004_MAX_SKEW_SECONDS} seconds of server time.`);
  }
  const agentId = BigInt(params.agentIdHeader);
  let signer: Address;
  try {
    signer = await recoverMessageAddress({
      message: erc8004RequestMessage(params.method, params.originalUrl, params.timestamp, params.agentIdHeader),
      signature: params.signature as Hex,
    });
  } catch {
    return bad(401, "erc8004_invalid", "Signature could not be recovered.");
  }
  let owner: Address | null = null;
  let wallet: Address | null = null;
  try {
    [owner, wallet] = await Promise.all([params.reader.ownerOf(agentId), params.reader.agentWallet(agentId)]);
  } catch {
    return bad(403, "erc8004_unverified", "Could not read the ERC-8004 registry.");
  }
  const s = signer.toLowerCase();
  if ((owner && owner.toLowerCase() === s) || (wallet && wallet.toLowerCase() === s)) {
    return { ok: true, agent: { agentId, address: signer } };
  }
  return bad(403, "erc8004_not_owner", "Signer is neither the owner nor the agent wallet of this ERC-8004 agent on Celo.");
}

const REGISTRY_ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
]);

export function createCeloErc8004Reader(rpcUrl: string, registry: Address = CELO_ERC8004_REGISTRY): Erc8004Reader {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const read = async (functionName: "ownerOf" | "getAgentWallet", agentId: bigint): Promise<Address | null> => {
    try {
      return (await client.readContract({ address: registry, abi: REGISTRY_ABI, functionName, args: [agentId] })) as Address;
    } catch {
      return null;
    }
  };
  return { ownerOf: (id) => read("ownerOf", id), agentWallet: (id) => read("getAgentWallet", id) };
}
