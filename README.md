# VetGate Celo（Self Agent ID + Altana PayGuard）

## 審査用クイック確認カード

| 項目 | 値 |
|---|---|
| ネットワーク | Celo mainnet `42220`（試験は `11142220` — [chain.ts](src/chain.ts)） |
| PayGuard | `0xde00a2f23792e3cadbf0088a1b93276748a5666c`（[MAINNET_RUN.md](MAINNET_RUN.md)） |
| Oracle signer / Self 194 / ERC-8004 | `0x970b37B3C58eDc62Cccb7BeeaB5972bC7c6b0435`（agentId **9907**） |
| Altana 買い手 admin（nonce 0） | `0xCDb0FF6e6Dfc33F9d75288772c8EfFaa13df9941` |
| ERC-8021 attribution | `celo_56284feb7672` |
| x402 facilitator（mainnet） | `https://api.x402.celo.org` |
| vet402 seller check | `https://vet402.com/api/v1/check?url=` |
| mainnet 実行ログ | [MAINNET_RUN.md](MAINNET_RUN.md) |

```bash
forge test --summary && npm test && npm run check-no-keys
npx tsx scripts/mainnet-plan.ts
VETGATE_NETWORK=mainnet VETGATE_PAY_GUARD_ADDRESS=0xde00a2f23792e3cadbf0088a1b93276748a5666c \
  npx tsx scripts/mainnet-run.ts --step 3 --dry
```

## アーキテクチャ（鍵の役割）

| 鍵 | 住所 | 用途 |
|---|---|---|
| `.secrets/mainnet-admin.key` | 0x970b… | PayGuard oracle 署名、Self agent 194、ERC-8004 #9907、買い手 USDC 送金 |
| `.secrets/altana-admin.key` | 0xCDb0… | steps **3–7** の `createWallet` / `grantSession` / `execute` / `revokeSession` |
| `.secrets/session.key` | （生成） | 買い手セッションキー（step 3 後） |

## トラック要件チェックリスト

| 要件 | 実装 |
|---|---|
| PayGuard: ALLOW 署名付き permit のみ送金 | [VetGatePayGuard.sol](contracts/VetGatePayGuard.sol) |
| Self `sybilLimit(0)` + 日次無料枠 | [app.ts](src/app.ts)・[daily-quota.ts](src/daily-quota.ts) |
| x402 mainnet facilitator | [chain.ts](src/chain.ts)・[server.ts](src/server.ts) |
| Altana ALLOW/BLOCK/revoke | [mainnet-executor.ts](src/mainnet-executor.ts)・[agent-buyer.ts](src/agent-buyer.ts) |
| mainnet 段階実行 + 1 USDC 上限 | [scripts/mainnet-run.ts](scripts/mainnet-run.ts) |
| 定時少額ループ | [scripts/daily.ts](scripts/daily.ts) |
| Fly デプロイ用テンプレ（**未デプロイ**） | [Dockerfile](Dockerfile)・[fly.toml](fly.toml) `vetgate-celo` |

## オーナー待ち

| 項目 | 状態 |
|---|---|
| mainnet steps 3–7 送信 | オーナー承認後（本セッションは送信しない） |
| `X402_API_KEY`（x402.celo.org） | 未 |
| Fly デプロイ | 意図的に未 |

## ライセンス

[MIT](LICENSE)