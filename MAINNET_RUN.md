# Celo mainnet 実行記録（42220）

**状態:** PayGuard デプロイ済み（`0xde00a2f23792e3cadbf0088a1b93276748a5666c`）。steps 2–7 はオーナー実行待ち。

オーナーが admin ウォレット（`0x970b37B3C58eDc62Cccb7BeeaB5972bC7c6b0435`）へ CELO/USDC を入れたあと:

```bash
npx tsx scripts/mainnet-plan.ts
# ドライラン（送信なし）例:
VETGATE_NETWORK=mainnet VETGATE_PAY_GUARD_ADDRESS=0xde00a2f23792e3cadbf0088a1b93276748a5666c \
  npx tsx scripts/mainnet-run.ts --step 3 --dry
npx tsx scripts/mainnet-run.ts --i-understand-mainnet --step 2
```

| Step | Tx hash | Note | UTC |
|---|---|---|---|
| deploy_pay_guard | `0x3e15259a34df3b115d1d47f6f96a931f18f6a8558682ddb99d8a32fa0fb0f0b8` | PayGuard CREATE + ERC-8021 suffix | 2026-11-23T10:40:02.551Z |
| register_erc8004_seller | _—_ | skip if agentId 9907 owned by admin | — |
| altana_wallet_and_session | _—_ | grantSession + `.secrets/session.key` | — |
| demo_allow_payment | _—_ | ALLOW 0.01 USDC | — |
| demo_block_revert | _—_ | BLOCK revert デモ | — |
| revoke_session | _—_ | セッション無効化 | — |
| daily_small_use | _—_ | `--daily` 定時少額（UTC 日次） | — |

`scripts/mainnet-run.ts` が成功するたびにこの表へ行が追記されます。

## Run state

- pay_guard: `0xde00a2f23792e3cadbf0088a1b93276748a5666c`
- attribution: `celo_56284feb7672`