# Celo mainnet 実行記録（42220）

**状態:** PayGuard デプロイ済み（`0xde00a2f23792e3cadbf0088a1b93276748a5666c`）。Altana 買い手は **0xCDb0…9941**（nonce 0）。Oracle/Self/8004 は **0x970b…0435**（agentId **9907** skip）。

```bash
# ドライラン（relay quote・送信なし）
VETGATE_NETWORK=mainnet VETGATE_PAY_GUARD_ADDRESS=0xde00a2f23792e3cadbf0088a1b93276748a5666c \
  npx tsx scripts/mainnet-run.ts --step 3 --dry
# step 5 BLOCK（直接 EOA・gas 200000）ドライ
VETGATE_NETWORK=mainnet VETGATE_PAY_GUARD_ADDRESS=0xde00a2f23792e3cadbf0088a1b93276748a5666c \
  npx tsx scripts/mainnet-run.ts --step 5 --dry
# 本番送信（オーナー承認後）
npx tsx scripts/mainnet-run.ts --i-understand-mainnet --step 5
# 定時少額（UTC 日次・冪等）
npx tsx scripts/daily.ts --dry
npx tsx scripts/daily.ts --i-understand-mainnet
```

| Step | Tx hash | Note | UTC |
|---|---|---|---|
| deploy_pay_guard | `0x3e15259a34df3b115d1d47f6f96a931f18f6a8558682ddb99d8a32fa0fb0f0b8` | PayGuard CREATE + ERC-8021 suffix | 2026-11-23T10:40:02.551Z |
| register_erc8004_seller | _—_ | skip if agentId 9907 owned by admin | — |
| altana_wallet_and_session | `0x3c5589e853ca01191373d325c22479602fe90cefb7ed4addde25a0f5ef991549` | grantSession PayGuard.payWithPermit cap 1 USDC/day | 2026-11-23T11:36:50.645Z |
| usdc_approve_pay_guard | `0x592c67953e4968f936ccb734d5cc22004a5c791c857a53b441449b5a56ca65ee` | USDC approve PayGuard 10000 units | 2026-11-23T11:43:03.756Z |
| demo_allow_payment | `0xf1ddb4f25a50b905ef4dd3ce7bf0b8225132eda63a093abedf52793d6a5b0731` | ALLOW payWithPermit vet402 → 0x20faaca5f980e29639a0fcc6dca6988e18ed333b | 2026-11-23T11:43:11.537Z |
| demo_block_revert | `0xrevert` | BLOCK revert visible: relay path (superseded: relay path did not land on chain) | 2026-11-23T11:43:15.368Z |
| revoke_session | `0xfda5d955f808b9637961f6945cd9ee1704502bf31746677fc0912f2bd65aeeb7` | revokeSession (pre-fix: no relay suffix) | 2026-11-23T11:43:23.431Z |

`scripts/mainnet-run.ts` が成功するたびにこの表へ行が追記されます。step 5 の本番は Altana admin EOA 直接送信（gas 200000）で置き換え予定。

## Run state
- demo_seller_source: `vet402`
- demo_seller_payto: `0x20faaca5f980e29639a0fcc6dca6988e18ed333b`
- buyer_wallet: `0xCDb0FF6e6Dfc33F9d75288772c8EfFaa13df9941`
- pay_guard: `0xde00a2f23792e3cadbf0088a1b93276748a5666c`
- attribution: `celo_56284feb7672`
- oracle_signer: `0x970b37B3C58eDc62Cccb7BeeaB5972bC7c6b0435`
- altana_admin: `0xCDb0FF6e6Dfc33F9d75288772c8EfFaa13df9941`
- erc8004_agent: `9907`（step 2 skip）
- demo_seller_default: `https://gateway.usebuy.ai/v1/social/tiktok/profile`（vet402 ALLOW → payTo on Celo）