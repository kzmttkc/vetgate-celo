# VetGate Celo (Self Agent ID + Altana PayGuard)

## Judge quick card (mainnet 42220)

| Item | Value |
|---|---|
| Live VetGate HTTP (Vercel) | https://vetgate-celo-orcin.vercel.app |
| Network | Celo mainnet `42220` (test harness `11142220` in [chain.ts](src/chain.ts)) |
| PayGuard | `0xde00a2f23792e3cadbf0088a1b93276748a5666c` ([MAINNET_RUN.md](MAINNET_RUN.md)) |
| Session grant (step 3) | [0x3c5589e853ca01191373d325c22479602fe90cefb7ed4addde25a0f5ef991549](https://celoscan.io/tx/0x3c5589e853ca01191373d325c22479602fe90cefb7ed4addde25a0f5ef991549) (`2026-11-23T11:36:50.645Z`) |
| ALLOW payWithPermit (step 4) | [0xf1ddb4f25a50b905ef4dd3ce7bf0b8225132eda63a093abedf52793d6a5b0731](https://celoscan.io/tx/0xf1ddb4f25a50b905ef4dd3ce7bf0b8225132eda63a093abedf52793d6a5b0731) (`2026-11-23T11:43:11.537Z`) |
| revokeSession (step 6) | [0xfda5d955f808b9637961f6945cd9ee1704502bf31746677fc0912f2bd65aeeb7](https://celoscan.io/tx/0xfda5d955f808b9637961f6945cd9ee1704502bf31746677fc0912f2bd65aeeb7) (`2026-11-23T11:43:23.431Z`, **before** step 5 BLOCK) |
| BLOCK revert (step 5) | [0x385d54da5f82f863e055e9edfa4057478f399cf8df28a5ce81b734accdf0d15e](https://celoscan.io/tx/0x385d54da5f82f863e055e9edfa4057478f399cf8df28a5ce81b734accdf0d15e) (`2026-11-23T11:49:23.012Z`, direct EOA `0xCDb0…9941`, status 0, `VerdictNotAllow`) |
| Oracle / Self agent 194 / ERC-8004 #9907 | `0x970b37B3C58eDc62Cccb7BeeaB5972bC7c6b0435` |
| Altana buyer admin | `0xCDb0FF6e6Dfc33F9d75288772c8EfFaa13df9941` |
| Self agent registry | https://agent-api.self.xyz/api/agent/info/42220/194 |
| ERC-8004 agent | https://8004scan.io/9907 |
| ERC-8021 attribution | `celo_56284feb7672` |
| x402 facilitator | https://api.x402.celo.org |
| vet402 seller check | https://vet402.com/api/v1/check?url= |

```bash
forge test --summary && npm test && npm run check-no-keys
VETGATE_CELO_NETWORK=mainnet VETGATE_PAY_GUARD_ADDRESS=0xde00a2f23792e3cadbf0088a1b93276748a5666c \
  npx tsx scripts/mainnet-run.ts --step 5 --dry
```

### Live deployment checks

| Route | Expected |
|---|---|
| `GET /health` | `{"ok":true,"network":"mainnet","chainId":42220}` |
| `GET /v1/stats` | `{"network":"eip155:42220","stats":{...}}` (no Self headers required) |
| `GET /v1/permit?...` without Self headers | HTTP `401`, JSON error `self_agent_required` |
| `GET /v1/permit?...` with valid Self agent 194 signature | HTTP `200` with `verdict`, `permit`, `tier`, `freeQuota` (free tier), and vet402 fields when ALLOW |

### Self-signed permit demo (read-only HTTP)

Requires `VETGATE_ORACLE_SIGNER_PK` or a local `.secrets/mainnet-admin.key` (oracle / Self agent 194).

```bash
VETGATE_CELO_NETWORK=mainnet npx tsx scripts/self-permit-demo.ts
```

Expected JSON shape on stdout (single object):

```json
{
  "status": 200,
  "body": {
    "tier": "free",
    "verdict": "ALLOW",
    "freeQuota": {
      "key": "0x…",
      "used": false,
      "scope": "per human per UTC day, shared across all agents of that human"
    },
    "permit": {
      "payTo": "0x…",
      "token": "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
      "maxAmount": "…",
      "expiresAt": "…",
      "nonce": "0x…",
      "verdictCode": 1,
      "signature": "0x…"
    },
    "vet402": { "recommendation": "ALLOW", "…": "…" }
  }
}
```

Each human (Self nullifier) gets one free permit per UTC day across all of their agents. The free permit `nonce` is deterministic (`vetgate-free-v1` + nullifier + UTC day) and shared with PayGuard’s `usedNonces` on Celo mainnet. After that nonce is used on-chain—or when the oracle cannot confirm it is free—the same call may return HTTP `402` with `x402_payment_required` and `freeQuota.used: true` (no nullifier in the JSON).

### Same human, two agents

The oracle verifies Self agents with `.sybilLimit(0)` and counts the free tier per human (nullifier), not per agent. Two agents registered by the same person get the same free `nonce`; once one of them uses it on-chain, the other gets HTTP `402`. This is covered in [test/free-quota-chain.test.ts](test/free-quota-chain.test.ts) (`derives the same free nonce for the same nullifier across different agent IDs`, `returns 402 when PayGuard.usedNonces is true (second agent, fresh instance cache)`). On mainnet, agent 194 returned `200` free, then `402` with the same key on the second call.

### Two agents, one person (Celo Sepolia mock passport)

**Testnet only** — demonstrates the hackathon “verified agent + second agent turned away, shared per-person limit” using two Self agents on **Celo Sepolia** (mock passport, same human / nullifier: `agent-a`, `agent-b`). This is **not** mainnet Self agent 194; mainnet production behavior is described in the sections above.

Export keys with the Self agent CLI (`register` + `export --out-key`) into `.self/agent-a.key` and `.self/agent-b.key`. The script starts VetGate locally (`VETGATE_CELO_NETWORK=testnet`), verifies agents on Sepolia, and reads **mainnet** PayGuard `usedNonces` over RPC (read-only) at `0xde00a2f23792e3cadbf0088a1b93276748a5666c` without pointing `CELO_RPC_URL` at mainnet (that would mix RPC with testnet Self signing). Also needs `.secrets/testnet.key` (or `VETGATE_ORACLE_SIGNER_PK`) for the oracle.

```bash
VETGATE_CELO_NETWORK=testnet npx tsx scripts/two-agent-demo.ts
# optional: --agent-a-key path --agent-b-key path
# or VETGATE_AGENT_A_KEY_FILE / VETGATE_AGENT_B_KEY_FILE
```

Expected stdout (one line per step, for demo video): `(1)` HTTP `401` without signature; `(2)` `agent-a` HTTP `200` `tier=free`; `(3)` `agent-b` HTTP `402` `x402_payment_required` with the same `freeQuota.key` as step 2. Missing key files → exit code `2` and a single guidance line.

### One-shot x402 buyer (default dry)

Default dry needs no key: it prints HTTP `402` `accepts[]`, the selected Celo mainnet exact offer, and an unsigned EIP-3009 template (`eip3009SignPreview`; payer defaults to the operator address unless `VETGATE_BUY_ONCE_PAYER` is set). Add `--with-signed-payload` (or run live) to emit `paymentPayloadV2`; those paths need `VETGATE_ORACLE_SIGNER_PK` or `.secrets/mainnet-admin.key`.

```bash
VETGATE_CELO_NETWORK=mainnet npx tsx scripts/buy-once.ts
```

Live payment requires `--i-understand-mainnet` and records `buy_purchase` in [MAINNET_RUN.md](MAINNET_RUN.md).

Mainnet scripts require `--i-understand-mainnet` for live broadcast. See [MAINNET_RUN.md](MAINNET_RUN.md) for the full tx table.

The Altana session demo is mainnet steps **3**, **4**, and **6** (grant, ALLOW `payWithPermit`, `revokeSession`). Step **5** is a direct EOA `0xCDb0…9941` `payWithPermit` BLOCK revert (`VerdictNotAllow`), not an Altana session `execute`. `revokeSession` (step 6) mined at `2026-11-23T11:43:23.431Z`, before the BLOCK tx at `2026-11-23T11:49:23.012Z`. The daily loop (`scripts/daily.ts`, step 7) pays 0.01 USDC from the operator wallet after a public vet402 ALLOW check and a locally minted oracle permit (no Altana session or VetGate HTTP). Daily on-chain traffic is intentional operator use, not buyer-session automation.

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
| Self sybilLimit(0) on `/v1/permit` | [app.ts](src/app.ts#L122-L130) |
| Daily human quota | Deterministic free nonce + PayGuard `usedNonces` RPC ([daily-quota.ts](src/daily-quota.ts), [chain.ts](src/chain.ts), [app.ts](src/app.ts#L243-L300)); in-memory cache only within one instance |
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
| `VETGATE_CELO_NETWORK` | `mainnet` (scripts fall back to `VETGATE_NETWORK` when unset) |
| `VETGATE_PAY_GUARD_ADDRESS` | `0xde00a2f23792e3cadbf0088a1b93276748a5666c` |
| `VETGATE_ORACLE_SIGNER_PK` | Oracle private key (never commit) |
| `VETGATE_PAYTO_ADDRESS` | x402 payTo for paid tier |
| `CELO_ATTRIBUTION_TAG` | `celo_56284feb7672` |
| `X402_API_KEY` | Optional, enables paid quota settlement |
| `CELO_FACILITATOR_URL` | Optional, defaults to mainnet facilitator when network is mainnet |

**Daily quota on Vercel:** the source of truth is PayGuard `usedNonces` on Celo mainnet, read over RPC for every free permit. [DailyHumanQuota](src/daily-quota.ts) is only an in-memory cache inside one serverless instance; a cold start or another region re-reads the chain, so the quota does not reset.

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