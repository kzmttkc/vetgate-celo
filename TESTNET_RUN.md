# Celo Sepolia 試験網での実行記録（2026-11-23）

対象チェーン：**11142220（Celo Sepolia）のみ**。mainnet への送金・RPC は意図的に行っていません。

## ローカルで通したもの（オフチェーン）

| 項目 | コマンド | 結果 |
|---|---|---|
| Solidity 単体 | `forge test --summary` | 9 passed / 0 failed |
| TypeScript 単体 | `npm test` | 7 passed / 7 tests |
| 秘密鍵生成 | `npm run gen-testnet-key` | `.secrets/testnet.key`（chmod 600、表示なし） |

## オンチェーン（tx ハッシュ）

| 操作 | ハッシュ | 状態 |
|---|---|---|
| PayGuard デプロイ | — | **未実施**（下記「止まった理由」） |
| Altana `grantSession` / `execute` / `revokeSession` | — | **未実施**（資金・Self 登録なし） |
| x402 決済（`api.x402.sepolia.celo.org`） | — | **未実施**（`X402_API_KEY` 未設定） |

## 止まった理由（オーナー対応が必要）

1. **CELO Sepolia ネイティブトークン**  
   - 公式 https://faucet.celo.org/celo-sepolia は **reCAPTCHA v3** あり。スクリプト単体では不可。  
   - 回避には **API キー（Bearer）** または **GitHub サインイン**（3 CELO/回）が必要（ページに明記）。  
   - Circle USDC: https://faucet.circle.com（要確認・多くの場合ログイン/Captcha）。

2. **x402 Sepolia facilitator**  
   - 有料枠超過後の settlement には https://x402.celo.org で **ウォレット署名による API キー発行**が必要（grok_docs 実測: testnet 無料 1000 credits）。

3. **Self Agent ID（Celo Sepolia / モック旅券）**  
   - サーバー実機検証には登録済みエージェント鍵と `SelfAgent` 署名が必要（パスポート + Self アプリ QR、オーナー操作）。

4. **Altana ライブパス**  
   - SDK は Celo Sepolia をサポート（`CELO_SEPOLIA`、relay `testnet-relay.altana.network`）。  
   - 本リポでは CI 向けに `VETGATE_ALTANA_MOCK=1` を既定（`.env.example`）。ライブ試験には CELO/USDC 入金 + admin 鍵が必要。

## 実施しなかったもの（仕様どおり）

- GitHub push / 公開ホストデプロイ
- mainnet（42220）RPC・トランザクション
- `~/.vet402-keys`、実値 `.env`、`~/vouch` の参照