# VetGate Celo (Self Agent ID + Altana PayGuard)

## Judge quick card (mainnet 42220)

| Item | Value |
|---|---|
| Network | Celo mainnet `42220` (test harness `11142220` in [chain.ts](src/chain.ts)) |
| PayGuard | `0xde00a2f23792e3cadbf0088a1b93276748a5666c` ([MAINNET_RUN.md](MAINNET_RUN.md)) |
| Session grant (step 3) | [0x3c5589e853ca01191373d325c22479602fe90cefb7ed4addde25a0f5ef991549](https://celoscan.io/tx/0x3c5589e853ca01191373d325c22479602fe90cefb7ed4addde25a0f5ef991549) |
| ALLOW payWithPermit (step 4) | [0xf1ddb4f25a50b905ef4dd3ce7bf0b8225132eda63a093abedf52793d6a5b0731](https://celoscan.io/tx/0xf1ddb4f25a50b905ef4dd3ce7bf0b8225132eda63a093abedf52793d6a5b0731) |
| BLOCK revert (step 5) | [0x385d54da5f82f863e055e9edfa4057478f399cf8df28a5ce81b734accdf0d15e](https://celoscan.io/tx/0x385d54da5f82f863e055e9edfa4057478f399cf8df28a5ce81b734accdf0d15e) (status 0, `VerdictNotAllow`) |
| revokeSession (step 6) | [0xfda5d955f808b9637961f6945cd9ee1704502bf31746677fc0912f2bd65aeeb7](https://celoscan.io/tx/0xfda5d955f808b9637961f6945cd9ee1704502bf31746677fc0912f2bd65aeeb7) |
| Oracle / Self agent 194 / ERC-8004 #9907 | `0x970b37B3C58eDc62Cccb7BeeaB5972bC7c6b0435` |
| Altana buyer admin (nonce 0) | `0xCDb0FF6e6Dfc33F9d75288772c8EfFaa13df9941` |
| Self agent registry | https://agent-api.self.xyz/api/agent/info/42220/194 |
| ERC-8004 agent | https://8004scan.io/9907 |
| ERC-8021 attribution | `celo_56284feb7672` |
| x402 facilitator | https://api.x402.celo.org |
| vet402 seller check | https://vet402.com/api/v1/check?url= |

```bash
forge test --summary && npm test && npm run check-no-keys
VETGATE_NETWORK=mainnet VETGATE_PAY_GUARD_ADDRESS=0xde00a2f23792e3cadbf0088a1b93276748a5666c \
  npx tsx scripts/mainnet-run.ts --step 5 --dry
```

Mainnet scripts require `--i-understand-mainnet` for live broadcast. See [MAINNET_RUN.md](MAINNET_RUN.md) for the full tx table.

The Altana session demo is mainnet steps 3 to 6. The daily loop (`scripts/daily.ts`, step 7) pays 0.01 USDC from the operator wallet after a public vet402 ALLOW check and a locally minted oracle permit (no Altana session or VetGate HTTP). Daily on-chain traffic is intentional operator use, not buyer-session automation.

## Accounting (operator vs independent)

| Actor | Wallet | Role on chain |
|---|---|---|
| Operator / oracle | `0x970b37B3C58eDc62Cccb7BeeaB5972bC7c6b0435` | PayGuard oracle signer, Self agent 194, ERC-8004 token 9907, VetGate oracle HTTP |
| Buyer admin (operated by me, separate key) | `0xCDb0FF6e6Dfc33F9d75288772c8EfFaa13df9941` | Altana EIP-7702 buyer, grantSession, execute, revokeSession, step 5 direct BLOCK tx |
| Third-party x402 seller payTo (gateway.usebuy.ai) | `0x20faaca5f980e29639a0fcc6dca6988e18ed333b` | Receives the ALLOW payment. vet402's public check returned ALLOW for this seller |

The operator wallet mints permits and deploys PayGuard. The buyer admin wallet is a separate EOA that holds the session key material under `.secrets/session.key`. Neither wallet is the vet402 seller payTo.

## Track requirement checklist

| Requirement | Implementation |
|---|---|
| PayGuard enforces ALLOW permits | [VetGatePayGuard.sol](contracts/VetGatePayGuard.sol#L97-L100) |
| Self sybilLimit(0) on `/v1/permit` | [app.ts](src/app.ts#L95-L103) |
| Daily human quota | [daily-quota.ts](src/daily-quota.ts), [app.ts](src/app.ts#L209-L210) |
| x402 facilitator wiring | [chain.ts](src/chain.ts#L15-L16), [oracle-bootstrap.ts](src/oracle-bootstrap.ts) |
| ERC-8021 on relay + calls | [attributed-altana-client.ts](src/attributed-altana-client.ts), [attribution.ts](src/attribution.ts) |
| Mainnet step runner | [mainnet-executor.ts](src/mainnet-executor.ts), [scripts/mainnet-run.ts](scripts/mainnet-run.ts) |
| Daily idempotent loop | [scripts/daily.ts](scripts/daily.ts), operator EOA `payWithPermit` in [mainnet-executor.ts](src/mainnet-executor.ts) step 7 |
| Vercel deploy | [vercel.json](vercel.json), [src/vercel-api.ts](src/vercel-api.ts), [scripts/build-vercel-api.mjs](scripts/build-vercel-api.mjs) |
| Fly deploy (optional) | [fly.toml](fly.toml), [Dockerfile](Dockerfile), health [app.ts](src/app.ts) |
| Secret leak guard | [scripts/check-no-keys.mjs](scripts/check-no-keys.mjs) |

## Hosting on Vercel

The Express app is bundled to `api/index.mjs` at build time from [src/vercel-api.ts](src/vercel-api.ts) (esbuild, ESM) so `@noble/ed25519` is not loaded via `require()` on Vercel. [vercel.json](vercel.json) rewrites all paths to `/api`.

**Production environment variables** (set in the Vercel dashboard or CLI):

| Variable | Example / note |
|---|---|
| `VETGATE_CELO_NETWORK` | `mainnet` |
| `VETGATE_PAY_GUARD_ADDRESS` | `0xde00a2f23792e3cadbf0088a1b93276748a5666c` |
| `VETGATE_ORACLE_SIGNER_PK` | Oracle private key (never commit) |
| `VETGATE_PAYTO_ADDRESS` | x402 payTo for paid tier |
| `CELO_ATTRIBUTION_TAG` | `celo_56284feb7672` |
| `X402_API_KEY` | Optional, enables paid quota settlement |
| `CELO_FACILITATOR_URL` | Optional, defaults to mainnet facilitator when network is mainnet |

**Daily quota on Vercel:** [DailyHumanQuota](src/daily-quota.ts) is an in-memory `Map` per serverless instance. Free-tier counts reset when a new instance cold-starts and do not sync across regions. This matches the current code path with no local disk.

Local dev: `npm start` (reads `.secrets/` when `VETGATE_ORACLE_SIGNER_PK` is unset).

## Keys (local only, never committed)

| File | Address | Use |
|---|---|---|
| `.secrets/mainnet-admin.key` | 0x970b…0435 | Oracle signer, Self agent, ERC-8004 #9907 |
| `.secrets/altana-admin.key` | 0xCDb0…9941 | Altana admin for steps 3 to 6 |
| `.secrets/session.key` | generated | Session key after grant |

Vercel production sets `VETGATE_ORACLE_SIGNER_PK` and related env from the Vercel project settings (see `.env.example`).

## License

[MIT](LICENSE)