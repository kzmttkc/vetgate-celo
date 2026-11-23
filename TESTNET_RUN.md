# Celo Sepolia run log (2026-11-23)

Target chain: **11142220 (Celo Sepolia) only**. No mainnet transfers or mainnet RPC in this log.

## Local checks (off-chain)

| Item | Command | Result |
|---|---|---|
| Solidity unit tests | `forge test --summary` | 9 passed / 0 failed |
| TypeScript unit tests | `npm test` | 7 passed / 7 tests |
| Key generation | `npm run gen-testnet-key` | `.secrets/testnet.key` (chmod 600, no console output) |

## On-chain (tx hashes)

| Action | Hash | Status |
|---|---|---|
| PayGuard deploy | — | **Not done** (see blockers below) |
| Altana `grantSession` / `execute` / `revokeSession` | — | **Not done** (no funds, no Self registration) |
| x402 payment (`api.x402.sepolia.celo.org`) | — | **Not done** (`X402_API_KEY` unset) |

## Blockers (owner action)

1. **CELO Sepolia native token**  
   - https://faucet.celo.org/celo-sepolia uses **reCAPTCHA v3**. Scripts cannot pass it alone.  
   - An **API key (Bearer)** or **GitHub sign-in** (3 CELO per request) is documented on that page.  
   - Circle USDC: https://faucet.circle.com (often requires login or Captcha).

2. **x402 Sepolia facilitator**  
   - Paid settlement after the free tier needs an API key from https://x402.celo.org via wallet signature (testnet free tier: 1000 credits in grok_docs notes).

3. **Self Agent ID (Celo Sepolia / mock passport)**  
   - Live server checks need a registered agent key and `SelfAgent` request signatures (passport + Self app QR, owner operation).

4. **Altana live path**  
   - SDK supports Celo Sepolia (`CELO_SEPOLIA`, relay `testnet-relay.altana.network`).  
   - This repo defaults to `VETGATE_ALTANA_MOCK=1` for CI (`.env.example`). Live trials need CELO or USDC funding plus an admin key.

## Intentionally skipped

- GitHub push or public host deploy
- Mainnet broadcast (`scripts/mainnet-run.ts`, planning only via `mainnet-plan.ts`)
- References to `~/.vet402-keys`, live `.env`, or `~/vouch`