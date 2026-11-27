# Celo mainnet run log (chain 42220)

**Status:** PayGuard deployed at `0xde00a2f23792e3cadbf0088a1b93276748a5666c`. Altana buyer **0xCDb0…9941**. Oracle, Self, and ERC-8004 **0x970b…0435** (agentId **9907** skip).

```bash
# Dry run (relay quote, no broadcast)
VETGATE_CELO_NETWORK=mainnet VETGATE_PAY_GUARD_ADDRESS=0xde00a2f23792e3cadbf0088a1b93276748a5666c \
  npx tsx scripts/mainnet-run.ts --step 3 --dry
# Step 5 BLOCK (direct EOA, gas 200000) dry run
VETGATE_CELO_NETWORK=mainnet VETGATE_PAY_GUARD_ADDRESS=0xde00a2f23792e3cadbf0088a1b93276748a5666c \
  npx tsx scripts/mainnet-run.ts --step 5 --dry
# Live broadcast (owner approval required)
VETGATE_CELO_NETWORK=mainnet VETGATE_PAY_GUARD_ADDRESS=0xde00a2f23792e3cadbf0088a1b93276748a5666c \
  npx tsx scripts/mainnet-run.ts --i-understand-mainnet --step 5
# Daily operator payWithPermit (UTC day, vet402 ALLOW, no Altana re-grant)
VETGATE_CELO_NETWORK=mainnet VETGATE_PAY_GUARD_ADDRESS=0xde00a2f23792e3cadbf0088a1b93276748a5666c \
  npx tsx scripts/daily.ts --dry
VETGATE_CELO_NETWORK=mainnet VETGATE_PAY_GUARD_ADDRESS=0xde00a2f23792e3cadbf0088a1b93276748a5666c \
  npx tsx scripts/daily.ts --i-understand-mainnet
```

| Step | Tx hash | Note | UTC |
|---|---|---|---|
| deploy_pay_guard | [0x3e15259a34df3b115d1d47f6f96a931f18f6a8558682ddb99d8a32fa0fb0f0b8](https://celoscan.io/tx/0x3e15259a34df3b115d1d47f6f96a931f18f6a8558682ddb99d8a32fa0fb0f0b8) | PayGuard CREATE + ERC-8021 suffix | 2026-11-23T10:40:02.551Z |
| register_erc8004_seller | _—_ | skip if agentId 9907 owned by admin | — |
| altana_wallet_and_session | [0x3c5589e853ca01191373d325c22479602fe90cefb7ed4addde25a0f5ef991549](https://celoscan.io/tx/0x3c5589e853ca01191373d325c22479602fe90cefb7ed4addde25a0f5ef991549) | grantSession PayGuard.payWithPermit cap 1 USDC/day | 2026-11-23T11:36:50.645Z |
| usdc_approve_pay_guard | [0x592c67953e4968f936ccb734d5cc22004a5c791c857a53b441449b5a56ca65ee](https://celoscan.io/tx/0x592c67953e4968f936ccb734d5cc22004a5c791c857a53b441449b5a56ca65ee) | USDC approve PayGuard 10000 units | 2026-11-23T11:43:03.756Z |
| demo_allow_payment | [0xf1ddb4f25a50b905ef4dd3ce7bf0b8225132eda63a093abedf52793d6a5b0731](https://celoscan.io/tx/0xf1ddb4f25a50b905ef4dd3ce7bf0b8225132eda63a093abedf52793d6a5b0731) | ALLOW payWithPermit vet402 → 0x20faaca5f980e29639a0fcc6dca6988e18ed333b | 2026-11-23T11:43:11.537Z |
| revoke_session | [0xfda5d955f808b9637961f6945cd9ee1704502bf31746677fc0912f2bd65aeeb7](https://celoscan.io/tx/0xfda5d955f808b9637961f6945cd9ee1704502bf31746677fc0912f2bd65aeeb7) | revokeSession | 2026-11-23T11:43:23.431Z |
| demo_block_revert | [0x385d54da5f82f863e055e9edfa4057478f399cf8df28a5ce81b734accdf0d15e](https://celoscan.io/tx/0x385d54da5f82f863e055e9edfa4057478f399cf8df28a5ce81b734accdf0d15e) | BLOCK direct EOA payWithPermit verdict=0 (VerdictNotAllow), status 0, gas=200000, ERC-8021 suffix | 2026-11-23T11:49:23.012Z |
| usdc_approve_pay_guard | `0x63aaa101597cce77ea42739872538142d86207bff8a886b5c6dd0da2a3cb8a9d` | operator USDC approve PayGuard cap 50000 units (daily) | 2026-11-23T13:05:21.974Z |
| daily_small_use | `0xd78bd93201bc0514e1551550f4d38b58842fc57e2fbcca30e109d47908b6e12b` | daily operator ALLOW payWithPermit vet402 utc=2026-11-23 → 0x20faaca5f980e29639a0fcc6dca6988e18ed333b | 2026-11-23T13:05:26.944Z |
| buy_purchase | `0x94c15cc3da1522d26df00e66129ddf2376210c25b2ee4989ae036f13b02264c2` | x402 usebuy bodySha256=0x9a00e598768d23cceb8686f6cc561c46520ec948589df3df49e40af428d05ae5 units=5000 | 2026-11-23T23:10:39.467Z |
| daily_small_use | `0xa5a9a11195763c782d85cf38edcd4105438b3fba499859dd0d07abca188b03a5` | daily operator ALLOW payWithPermit vet402 utc=2026-11-24 → 0x20faaca5f980e29639a0fcc6dca6988e18ed333b | 2026-11-24T01:01:45.924Z |
| daily_small_use | `0xbcdc6f7ea49197d17f8d3d7a495dfa614112cffb5ae64c04deaf1bdbcf844649` | daily operator ALLOW payWithPermit vet402 utc=2026-11-25 → 0x20faaca5f980e29639a0fcc6dca6988e18ed333b | 2026-11-25T01:01:51.106Z |
| daily_small_use | `0x6ae3d06b455b14d91f11c20f3a5114fe2aee63604c6bd8f2bf06d0219ac782f6` | daily operator ALLOW payWithPermit vet402 utc=2026-11-26 → 0x20faaca5f980e29639a0fcc6dca6988e18ed333b | 2026-11-26T01:01:56.753Z |
| daily_buy | `0xd5be396f1ea528df5ef9e2096a803bccfd60a0f82bca992ca574d5adcf0a3ae6` | x402 https://gateway.usebuy.ai/v1/social/tiktok/profile after vet402 ALLOW utc=2026-11-26 units=5000 bodyKeccak256=0xd945bba3310fd71580c41213a9e436af7f16b502b18f2c1b7cf4c10c5308d174 evidence=evidence/daily-buy/2026-11-26.json | 2026-11-26T12:24:51.885Z |
| daily_small_use | `0x1071f3b3d3520f25af57bbd90b8d604aac37738d984730abb037cc1518272317` | daily operator ALLOW payWithPermit vet402 utc=2026-11-27 → 0x20faaca5f980e29639a0fcc6dca6988e18ed333b | 2026-11-27T01:01:56.975Z |
| daily_buy | `0x76a8b7c6762de71ba375e1364566d0ec90282a53a42f744a860730b5649f843d` | x402 https://gateway.usebuy.ai/v1/social/tiktok/profile after vet402 ALLOW utc=2026-11-27 units=5000 bodyKeccak256=0xcad834e425ace09eeaa38d3f759a7e374262ddac506bb0d8d971bb640585b63f evidence=evidence/daily-buy/2026-11-27.json | 2026-11-27T01:02:05.720Z |

Each successful `scripts/mainnet-run.ts` run appends a row to this table.

## Run state

- demo_seller_source: `vet402`
- demo_seller_payto: `0x20faaca5f980e29639a0fcc6dca6988e18ed333b`
- buyer_wallet: `0xCDb0FF6e6Dfc33F9d75288772c8EfFaa13df9941`
- pay_guard: `0xde00a2f23792e3cadbf0088a1b93276748a5666c`
- attribution: `celo_56284feb7672`
- oracle_signer: `0x970b37B3C58eDc62Cccb7BeeaB5972bC7c6b0435`
- altana_admin: `0xCDb0FF6e6Dfc33F9d75288772c8EfFaa13df9941`
- erc8004_agent: `9907` (step 2 skip)
- self_agent: `194` (https://agent-api.self.xyz/api/agent/info/42220/194)
- erc8004_scan: https://8004scan.io/9907
- demo_seller_default: `https://gateway.usebuy.ai/v1/social/tiktok/profile` (vet402 ALLOW → payTo on Celo)