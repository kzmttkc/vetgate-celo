/** Celo Sepolia only — never import mainnet (42220) chain config here. */
export const CELO_SEPOLIA_CHAIN_ID = 11142220 as const;
export const CELO_SEPOLIA_CAIP2 = `eip155:${CELO_SEPOLIA_CHAIN_ID}` as const;

/** x402 Sepolia facilitator USDC (from GET https://api.x402.sepolia.celo.org/api/config). */
export const CELO_SEPOLIA_USDC = "0x01C5C0122039549AD1493B8220cABEdD739BC44E" as const;

export const CELO_SEPOLIA_RPC = "https://forno.celo-sepolia.celo-testnet.org" as const;

export const VET402_API_BASE = "https://vet402.com" as const;

export const DEFAULT_FACILITATOR_URL = "https://api.x402.sepolia.celo.org" as const;

/** Placeholder until Loops enrollment issues the real ERC-8021 code. */
export const PLACEHOLDER_ATTRIBUTION_TAG = "celo_56284feb7672" as const;