# Celo mainnet 実行記録（42220）

**状態:** PayGuard デプロイ済み（`0xde00a2f23792e3cadbf0088a1b93276748a5666c`）。Altana 買い手は **0xCDb0…9941**（nonce 0）。Oracle/Self/8004 は **0x970b…0435**（agentId **9907** skip）。

```bash
# ドライラン（relay quote・送信なし）
VETGATE_NETWORK=mainnet VETGATE_PAY_GUARD_ADDRESS=0xde00a2f23792e3cadbf0088a1b93276748a5666c \
  npx tsx scripts/mainnet-run.ts --step 3 --dry
# 本番送信（オーナー承認後）
npx tsx scripts/mainnet-run.ts --i-understand-mainnet --step 3
# 定時少額（UTC 日次・冪等）
npx tsx scripts/daily.ts --dry   # 見積もりのみ
npx tsx scripts/daily.ts         # 送信（要 --i-understand-mainnet 経由）
```

| Step | Tx hash | Note | UTC |
|---|---|---|---|
| deploy_pay_guard | `0x3e15259a34df3b115d1d47f6f96a931f18f6a8558682ddb99d8a32fa0fb0f0b8` | PayGuard CREATE + ERC-8021 suffix | 2026-11-23T10:40:02.551Z |
| register_erc8004_seller | _—_ | skip if agentId 9907 owned by admin | — |
| altana_wallet_and_session | _—_ | grantSession → `.secrets/session.key` | — |
| demo_allow_payment | _—_ | ALLOW ≤0.01 USDC (vet402 seller) | — |
| demo_block_revert | _—_ | BLOCK revert デモ | — |
| revoke_session | _—_ | セッション無効化 | — |
| daily_small_use | _—_ | `--daily` 定時少額（UTC 日次） | — |

`scripts/mainnet-run.ts` が成功するたびにこの表へ行が追記されます。

## Run state
- demo_seller_source: `vet402`
- demo_seller_payto: `0x20faaca5f980e29639a0fcc6dca6988e18ed333b`
- buyer_wallet: `0xCDb0FF6e6Dfc33F9d75288772c8EfFaa13df9941`

- pay_guard: `0xde00a2f23792e3cadbf0088a1b93276748a5666c`
- attribution: `celo_56284feb7672`
- oracle_signer: `0x970b37B3C58eDc62Cccb7BeeaB5972bC7c6b0435`
- altana_admin: `0xCDb0FF6e6Dfc33F9d75288772c8EfFaa13df9941`
- erc8004_agent: `9907`（step 2 skip）
- demo_seller_default: `https://gateway.usebuy.ai/v1/social/tiktok/profile`（vet402 ALLOW → payTo on Celo）| altana_wallet_and_session | `0x3c5589e853ca01191373d325c22479602fe90cefb7ed4addde25a0f5ef991549` | grantSession PayGuard.payWithPermit cap 1 USDC/day | 2026-11-23T11:36:50.645Z |
