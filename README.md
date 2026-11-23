# VetGate Celo（Self Agent ID + Altana PayGuard）

## 審査用クイック確認カード

| 項目 | 値 |
|---|---|
| ネットワーク | Celo mainnet `42220`（試験は `11142220` — [chain.ts:29-44](src/chain.ts#L29-L44)） |
| Self Agent ID | _MAINNET_RUN.md またはオーナー登録後に記入_ |
| ERC-8004 agentId | _MAINNET_RUN.md_ |
| ERC-8021 attribution | `celo_56284feb7672`（[chain.ts:22](src/chain.ts#L22)） |
| PayGuard デプロイ tx | _MAINNET_RUN.md → `scripts/mainnet-run.ts --step 1`_ |
| x402 PayTo | _デプロイ後のオラクル住所（`.env` の `VETGATE_PAYTO_ADDRESS`）_ |
| x402 決済 tx | _facilitator settlement（タグは PayTo 登録でクレジット）_ |
| Altana session / execute | _MAINNET_RUN.md steps 3–6_ |

```bash
forge test --summary && npm test
npx tsx scripts/mainnet-plan.ts   # 送信なし・gas/USDC 見積もり
```

## トラック要件チェックリスト

| 要件 | 実装 |
|---|---|
| PayGuard: ALLOW 署名付き permit のみ送金 | [VetGatePayGuard.sol:65-87](contracts/VetGatePayGuard.sol#L65-L87) |
| revert: `ExpiredPermit` / `VerdictNotAllow` / … | [VetGatePayGuard.t.sol](test/VetGatePayGuard.t.sol) |
| `Attribution(bytes)` フォールバック | [VetGatePayGuard.sol:84-86](contracts/VetGatePayGuard.sol#L84-L86) |
| Self `sybilLimit(0)` + 日次無料枠 | [app.ts:100-105](src/app.ts#L100-L105)・[daily-quota.ts](src/daily-quota.ts) |
| mainnet / testnet 切替 | `VETGATE_CELO_NETWORK` [chain.ts:36-64](src/chain.ts#L36-L64) |
| x402 mainnet facilitator | `https://api.x402.celo.org` [chain.ts:16](src/chain.ts#L16) |
| ERC-8021 全書き込み経路 | [attribution.ts](src/attribution.ts)・[attribution.test.ts](test/attribution.test.ts) |
| Altana 買い手 ALLOW/BLOCK/revoke | [agent-buyer.ts](src/agent-buyer.ts) |
| `GET /v1/stats` チーム/独立 | [stats.ts](src/stats.ts)・[app.ts:157-159](src/app.ts#L157-L159) |
| mainnet 実行計画（ドライラン） | [scripts/mainnet-plan.ts](scripts/mainnet-plan.ts) |
| mainnet 段階実行 + 1 USDC 上限 | [scripts/mainnet-run.ts](scripts/mainnet-run.ts) |
| Fly デプロイ用テンプレ | [Dockerfile](Dockerfile)・[fly.toml](fly.toml)（**未デプロイ**） |

## 正直な会計（operator vs independent）

| 区分 | 根拠 |
|---|---|
| API の `tier`（free / paid） | [app.ts](src/app.ts) |
| チーム財布 | `VETGATE_TEAM_WALLETS` [stats.ts](src/stats.ts) |
| オンチェーン mainnet tx | **0** まで（[MAINNET_RUN.md](MAINNET_RUN.md) — 資金待ち） |
| オペレーター本人の定時利用 | mainnet-run step 7 + buy は **team** として集計 |

## ネットワーク

- 既定は **testnet**（`npm test` / CI）。本番は `VETGATE_CELO_NETWORK=mainnet`。
- Mainnet RPC: `https://forno.celo.org`。USDC: `0xcebA9300f2b948710d2653dD7B07f33A8B32118C`。
- Admin 用公開住所: `0x970b37B3C58eDc62Cccb7BeeaB5972bC7c6b0435`（鍵は `.secrets/mainnet-admin.key`、ログに出さない）。

## Self Agent ID（mainnet）— オーナー作業

`SelfAgentVerifier` は登録済みエージェントの Ed25519 署名を検証します（[app.ts:98-105](src/app.ts#L98-L105)）。**売り手サーバーを mainnet で公開する前に**:

1. `@selfxyz/agent-sdk` で `requestRegistration({ mode: "wallet-free", network: "mainnet" })`。
2. オーナーが Self アプリで QR をスキャン（実旅券）。
3. 完了後 `exportKey` → 売り手プロセス用の鍵（または API 用の署名のみ）。
4. 審査 URL: `GET https://agent-api.self.xyz/api/agent/info/42220/<agentId>`。

既存の Self **194** は vet402 本番財布用です。本リポの新エージェントは **別 ID** を推奨（CELO_PLAN 6.6）。買い手デモはオーナー登録の鍵で `SelfAgent.fetch` します。

## オーナー待ち・未実施

| 項目 | 状態 |
|---|---|
| Admin へ ~5 CELO + 10 USDC 入金 | 未 |
| `npx tsx scripts/mainnet-run.ts --i-understand-mainnet` | 未（計画のみ） |
| `X402_API_KEY`（x402.celo.org） | 未 |
| Self mainnet 新規 Agent ID | 未 |
| GitHub 公開リポ / Loops 以外の登録（PayTo・8004scan 等） | 未 |
| Fly デプロイ | 意図的に未 |
| buy 掲載 issue / 毎日少額 cron | コード外・オーナー承認後 |

## 制約

- 自動化は **チェーンへ送信しない**（`mainnet-plan` は read のみ）。
- push / 公開 GitHub / デプロイは行わない（ローカル git のみ）。