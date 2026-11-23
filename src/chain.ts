/** Celo network constants. Default runtime is Sepolia testnet (tests / CI). */

export const CELO_SEPOLIA_CHAIN_ID = 11142220 as const;
export const CELO_SEPOLIA_CAIP2 = `eip155:${CELO_SEPOLIA_CHAIN_ID}` as const;
export const CELO_SEPOLIA_USDC = "0x01C5C0122039549AD1493B8220cABEdD739BC44E" as const;
export const CELO_SEPOLIA_RPC = "https://forno.celo-sepolia.celo-testnet.org" as const;

export const CELO_MAINNET_CHAIN_ID = 42220 as const;
export const CELO_MAINNET_CAIP2 = `eip155:${CELO_MAINNET_CHAIN_ID}` as const;
export const CELO_MAINNET_USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as const;
export const CELO_MAINNET_RPC = "https://forno.celo.org" as const;

export const VET402_API_BASE = "https://vet402.com" as const;

export const CELO_SEPOLIA_FACILITATOR_URL = "https://api.x402.sepolia.celo.org" as const;
export const CELO_MAINNET_FACILITATOR_URL = "https://api.x402.celo.org" as const;

/** @deprecated Use resolveCeloRuntime().facilitatorUrl */
export const DEFAULT_FACILITATOR_URL = CELO_SEPOLIA_FACILITATOR_URL;

/** Loops enrollment ERC-8021 code (mainnet submissions). */
export const PLACEHOLDER_ATTRIBUTION_TAG = "celo_56284feb7672" as const;

/** Oracle signer, Self agent 194, ERC-8004 #9907 (`/.secrets/mainnet-admin.key`). */
export const MAINNET_ADMIN_ADDRESS = "0x970b37B3C58eDc62Cccb7BeeaB5972bC7c6b0435" as const;

/** Fresh EOA for Altana createWallet EIP-7702 auth at nonce 0 (`.secrets/altana-admin.key`). */
export const MAINNET_ALTANA_ADMIN_ADDRESS =
  "0xCDb0FF6e6Dfc33F9d75288772c8EfFaa13df9941" as const;

/**
 * Operator-controlled demo payTo when no vet402 ALLOW Celo seller is found.
 * Oracle signer remains {@link MAINNET_ADMIN_ADDRESS}; not used as payTo.
 */
export const MAINNET_CONTROLLED_SELLER_PAYTO =
  "0x1111111111111111111111111111111111111111" as const;

/** Documented fallback when vet402 has no ALLOW listing on Celo mainnet. */
export const MAINNET_CONTROLLED_SELLER_URL =
  "https://vetgate-celo.local/operator-controlled-demo-seller" as const;

export const MAINNET_CONTROLLED_SELLER_NOTE =
  "operator-controlled demo seller (oracle 0x970b…435, not x402 catalog)" as const;

export type VetgateCeloNetwork = "testnet" | "mainnet";

export type CeloRuntime = {
  network: VetgateCeloNetwork;
  chainId: number;
  caip2: string;
  rpc: string;
  usdc: `0x${string}`;
  facilitatorUrl: string;
  selfNetwork: "testnet" | "mainnet";
};

export function getVetgateCeloNetwork(): VetgateCeloNetwork {
  const raw = (process.env.VETGATE_CELO_NETWORK ?? "testnet").toLowerCase();
  if (raw === "mainnet" || raw === "42220" || raw === "celo") return "mainnet";
  return "testnet";
}

export function resolveCeloRuntime(): CeloRuntime {
  if (getVetgateCeloNetwork() === "mainnet") {
    return {
      network: "mainnet",
      chainId: CELO_MAINNET_CHAIN_ID,
      caip2: CELO_MAINNET_CAIP2,
      rpc: process.env.CELO_RPC_URL ?? CELO_MAINNET_RPC,
      usdc: CELO_MAINNET_USDC,
      facilitatorUrl: process.env.CELO_FACILITATOR_URL ?? CELO_MAINNET_FACILITATOR_URL,
      selfNetwork: "mainnet",
    };
  }
  return {
    network: "testnet",
    chainId: CELO_SEPOLIA_CHAIN_ID,
    caip2: CELO_SEPOLIA_CAIP2,
    rpc: process.env.CELO_RPC_URL ?? CELO_SEPOLIA_RPC,
    usdc: CELO_SEPOLIA_USDC,
    facilitatorUrl: process.env.CELO_FACILITATOR_URL ?? CELO_SEPOLIA_FACILITATOR_URL,
    selfNetwork: "testnet",
  };
}

export function resolveAttributionCode(): string {
  return process.env.CELO_ATTRIBUTION_TAG ?? PLACEHOLDER_ATTRIBUTION_TAG;
}