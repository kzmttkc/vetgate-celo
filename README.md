# VetGate Celo (Self Agent ID + Altana PayGuard)

## Judge quick card (mainnet 42220)

| Item | Value |
|---|---|
| Network | Celo mainnet `42220` (test harness `11142220` in [chain.ts](src/chain.ts)) |
| PayGuard | `0xde00a2f23792e3cadbf0088a1b93276748a5666c` ([MAINNET_RUN.md](MAINNET_RUN.md)) |
| Session grant (step 3) | `0x3c5589e853ca01191373d325c22479602fe90cefb7ed4addde25a0f5ef991549` |
| ALLOW payWithPermit (step 4) | `0xf1ddb4f25a50b905ef4dd3ce7bf0b8225132eda63a093abedf52793d6a5b0731` |
| BLOCK revert demo (step 5) | owner must send direct EOA tx (see MAINNET_RUN.md when recorded) |
| revokeSession (step 6) | `0xfda5d955f808b9637961f6945cd9ee1704502bf31746677fc0912f2bd65aeeb7` |
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

## Accounting (operator vs independent)

| Actor | Wallet | Role on chain |
|---|---|---|
| Operator / oracle | `0x970b37B3C58eDc62Cccb7BeeaB5972bC7c6b0435` | PayGuard oracle signer, Self agent 194, ERC-8004 token 9907, VetGate oracle HTTP |
| Independent buyer admin | `0xCDb0FF6e6Dfc33F9d75288772c8EfFaa13df9941` | Altana EIP-7702 buyer, grantSession, execute, revokeSession, step 5 direct BLOCK tx |
| vet402 seller payTo | `0x20faaca5f980e29639a0fcc6dca6988e18ed333b` | ALLOW demo payments only when vet402 lists ALLOW on Celo |

The operator wallet mints permits and deploys PayGuard. The buyer admin wallet is a separate EOA that holds the session key material under `.secrets/session.key`. Neither wallet is the vet402 seller payTo.

## Track requirement checklist

| Requirement | Implementation |
|---|---|
| PayGuard enforces ALLOW permits | [VetGatePayGuard.sol](contracts/VetGatePayGuard.sol#L97-L100) |
| Self sybilLimit(0) on `/v1/permit` | [app.ts](src/app.ts#L95-L103) |
| Daily human quota | [daily-quota.ts](src/daily-quota.ts), [app.ts](src/app.ts#L200-L206) |
| x402 facilitator wiring | [chain.ts](src/chain.ts#L15-L16), [server.ts](src/server.ts#L28-L39) |
| ERC-8021 on relay + calls | [attributed-altana-client.ts](src/attributed-altana-client.ts), [attribution.ts](src/attribution.ts) |
| Mainnet step runner | [mainnet-executor.ts](src/mainnet-executor.ts), [scripts/mainnet-run.ts](scripts/mainnet-run.ts) |
| Daily idempotent loop | [scripts/daily.ts](scripts/daily.ts), [mainnet-executor.ts](src/mainnet-executor.ts) daily step |
| Fly deploy template | [fly.toml](fly.toml), [Dockerfile](Dockerfile), health [app.ts](src/app.ts) |
| Secret leak guard | [scripts/check-no-keys.mjs](scripts/check-no-keys.mjs) |

## Keys (local only, never committed)

| File | Address | Use |
|---|---|---|
| `.secrets/mainnet-admin.key` | 0x970b…0435 | Oracle signer, Self agent, ERC-8004 #9907 |
| `.secrets/altana-admin.key` | 0xCDb0…9941 | Altana admin for steps 3 to 7 |
| `.secrets/session.key` | generated | Session key after grant |

Fly production sets `VETGATE_ORACLE_SIGNER_PK` and related env from Fly secrets (see `.env.example`).

## 日本語メモ

審査用の詳細ログは [MAINNET_RUN.md](MAINNET_RUN.md)。mainnet 送信は `--i-understand-mainnet` 必須。

## License

[MIT](LICENSE)