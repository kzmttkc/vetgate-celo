# Celo mainnet 実行記録（42220）

**未実施（コードのみ）。** オーナーが admin ウォレット（`0x970b37B3C58eDc62Cccb7BeeaB5972bC7c6b0435`）へ CELO/USDC を入れたあと:

```bash
npx tsx scripts/mainnet-plan.ts
npx tsx scripts/mainnet-run.ts --i-understand-mainnet --step 1
```

| Step | Tx hash | Note | UTC |
|---|---|---|---|
| deploy_pay_guard | _—_ | PayGuard デプロイ | — |
| register_erc8004_seller | _—_ | 売り手 ERC-8004 | — |
| altana_wallet_and_session | _—_ | grantSession | — |
| demo_allow_payment | _—_ | ALLOW 支払い | — |
| demo_block_revert | _—_ | BLOCK revert デモ | — |
| revoke_session | _—_ | セッション無効化 | — |
| daily_small_use | _—_ | 定時少額ループ | — |

`scripts/mainnet-run.ts` が成功するたびにこの表へ行が追記されます。