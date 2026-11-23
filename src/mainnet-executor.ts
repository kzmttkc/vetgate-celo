import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  CELO,
  buildErc8004RegisterCall,
  createClient,
  deserializeSession,
  erc8004Registry,
  serializeSession,
  signerFromPrivateKey,
  type Client,
  type Session,
} from "@altananetwork/sdk";
import { SelfAgent } from "@selfxyz/agent-sdk";
import { generatePrivateKey } from "viem/accounts";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  toFunctionSelector,
  type Hex,
} from "viem";
import { celo } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { appendAttributionSuffix } from "./attribution.js";
import { executeSessionPayWithPermit, fetchOraclePermit } from "./agent-buyer.js";
import {
  CELO_MAINNET_CHAIN_ID,
  CELO_MAINNET_USDC,
  MAINNET_ADMIN_ADDRESS,
  resolveAttributionCode,
  resolveCeloRuntime,
} from "./chain.js";
import {
  appendTxRow,
  assertStepNotDone,
  isDailyPaymentDoneUtc,
  isStepDone,
  MAINNET_EXISTING_ERC8004_AGENT_ID,
  SESSION_KEY_PATH,
  SESSION_META_PATH,
  upsertRunMetadata,
  utcDayStamp,
} from "./mainnet-run-log.js";
import {
  assertMainnetDemoAmount,
  assertSellerNotAdmin,
  MAINNET_DEMO_PAYMENT_UNITS,
  resolveMainnetSellerPayTo,
} from "./mainnet-seller.js";
import {
  assertUsdcWithinCap,
  buildDeployPayGuardCalldata,
  buildPayWithPermitCalldata,
  MAINNET_AGENT_URI,
  PAY_WITH_PERMIT_CALL_SIG,
  type MainnetRunStepId,
} from "./mainnet-runbook.js";

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
]);
const ERC8004_ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
]);

export type MainnetRunOptions = {
  dry: boolean;
  daily: boolean;
  allowTestnet: boolean;
  payGuard: `0x${string}`;
  adminPk: `0x${string}`;
  vetgateUrl: string;
  selfAgentPk: `0x${string}`;
  fundUsdcUnits?: bigint;
  blockGasCap?: bigint;
};

const DEFAULT_FUND_UNITS = 200_000n;
const DEFAULT_BLOCK_GAS = 600_000n;

export function assertMainnetChain(allowTestnet: boolean): void {
  const runtime = resolveCeloRuntime();
  if (runtime.chainId !== CELO_MAINNET_CHAIN_ID && !allowTestnet) {
    throw new Error(
      `refused: chainId ${runtime.chainId} (set VETGATE_CELO_NETWORK=mainnet or pass --testnet)`,
    );
  }
}

export function syncNetworkEnvFromAlias(): void {
  const alias = process.env.VETGATE_NETWORK?.toLowerCase();
  if (alias === "mainnet" || alias === "42220") {
    process.env.VETGATE_CELO_NETWORK = "mainnet";
  }
}

function publicClient() {
  const runtime = resolveCeloRuntime();
  return createPublicClient({
    chain: celo,
    transport: http(runtime.rpc),
  });
}

function printDryCall(label: string, detail: Record<string, unknown>): void {
  console.log(
    `[dry] ${label}: ${JSON.stringify(detail, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`,
  );
}

async function erc8004SkipRegister(admin: `0x${string}`): Promise<boolean> {
  const registry = erc8004Registry(CELO_MAINNET_CHAIN_ID);
  const client = publicClient();
  try {
    const owner = await client.readContract({
      address: registry,
      abi: ERC8004_ABI,
      functionName: "ownerOf",
      args: [MAINNET_EXISTING_ERC8004_AGENT_ID],
    });
    if (owner.toLowerCase() === admin.toLowerCase()) return true;
  } catch {
    /* not minted */
  }
  try {
    const bal = await client.readContract({
      address: registry,
      abi: ERC8004_ABI,
      functionName: "balanceOf",
      args: [admin],
    });
    if (bal > 0n) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function sessionPermissions(payGuard: `0x${string}`) {
  return {
    calls: [{ to: payGuard, signature: PAY_WITH_PERMIT_CALL_SIG }],
    spend: [{ limit: 1_000_000n, period: "day" as const, token: CELO_MAINNET_USDC }],
  };
}

function persistSessionKey(
  sessionPk: `0x${string}`,
  session: Session,
  walletAddress: `0x${string}`,
): void {
  mkdirSync(dirname(SESSION_KEY_PATH), { recursive: true });
  writeFileSync(SESSION_KEY_PATH, `${sessionPk}\n`, { mode: 0o600 });
  chmodSync(SESSION_KEY_PATH, 0o600);
  writeFileSync(SESSION_META_PATH, JSON.stringify(serializeSession(session), null, 2), {
    mode: 0o600,
  });
  chmodSync(SESSION_META_PATH, 0o600);
  upsertRunMetadata("buyer_wallet", walletAddress);
}

function loadBuyerSession(adminPk: `0x${string}`): {
  client: Client;
  session: Session;
  walletAddress: `0x${string}`;
} {
  const sessionPk = readFileSync(SESSION_KEY_PATH, "utf8").trim() as `0x${string}`;
  const stored = JSON.parse(readFileSync(SESSION_META_PATH, "utf8")) as ReturnType<
    typeof serializeSession
  >;
  const sessionSigner = signerFromPrivateKey(sessionPk);
  const session = deserializeSession(stored, sessionSigner);
  const client = createClient({ chains: [CELO], agentIdentity: false });
  return { client, session, walletAddress: stored.walletAddress };
}

export async function runMainnetStep(
  stepId: MainnetRunStepId,
  opts: MainnetRunOptions,
): Promise<void> {
  assertMainnetChain(opts.allowTestnet);
  const runtime = resolveCeloRuntime();
  const adminAccount = privateKeyToAccount(opts.adminPk);
  const tag = resolveAttributionCode();
  const fundUnits = opts.fundUsdcUnits ?? DEFAULT_FUND_UNITS;
  assertUsdcWithinCap(fundUnits, stepId);

  const guardOnce = !opts.dry;

  if (stepId === "deploy_pay_guard") {
    if (guardOnce) assertStepNotDone(stepId);
    if (opts.dry) {
      const data = buildDeployPayGuardCalldata(MAINNET_ADMIN_ADDRESS);
      printDryCall("deploy_pay_guard", { from: MAINNET_ADMIN_ADDRESS, data, suffix: tag });
      const gas = await publicClient()
        .estimateGas({ account: MAINNET_ADMIN_ADDRESS, data })
        .catch(() => undefined);
      if (gas !== undefined) printDryCall("estimateGas", { gas: gas.toString() });
      return;
    }
    const walletClient = createWalletClient({
      account: adminAccount,
      chain: celo,
      transport: http(runtime.rpc),
    });
    const data = buildDeployPayGuardCalldata(adminAccount.address);
    const hash = await walletClient.sendTransaction({ data, value: 0n });
    appendTxRow(stepId, hash, "PayGuard CREATE + ERC-8021 suffix");
    return;
  }

  if (stepId === "register_erc8004_seller") {
    if (await erc8004SkipRegister(adminAccount.address)) {
      console.log(`skip: already ${MAINNET_EXISTING_ERC8004_AGENT_ID}`);
      if (!isStepDone(stepId)) {
        appendTxRow(stepId, "0xskipped", `skip: already ${MAINNET_EXISTING_ERC8004_AGENT_ID}`);
      }
      return;
    }
    if (guardOnce) assertStepNotDone(stepId);
    const client = createClient({ chains: [CELO], agentIdentity: false });
    const admin = signerFromPrivateKey(opts.adminPk);
    const wallet = await client.createWallet({ signer: admin });
    const call = buildErc8004RegisterCall(CELO_MAINNET_CHAIN_ID, MAINNET_AGENT_URI, [
      {
        metadataKey: "x402Support",
        metadataValue: "0x" + Buffer.from("true", "utf8").toString("hex"),
      },
    ]);
    const tagged = appendAttributionSuffix(call.data);
    if (opts.dry) {
      printDryCall("register_erc8004", { wallet: wallet.address, to: call.to, data: tagged });
      return;
    }
    const result = await client.execute({
      wallet,
      signer: admin,
      chainId: CELO_MAINNET_CHAIN_ID,
      calls: [{ to: call.to, data: tagged }],
      feeToken: CELO_MAINNET_USDC,
    });
    if (result.transactionHash) {
      appendTxRow(stepId, result.transactionHash, `ERC-8004 register (${result.status})`);
    }
    return;
  }

  if (stepId === "altana_wallet_and_session") {
    if (guardOnce) assertStepNotDone(stepId);
    const sessionPk = (process.env.VETGATE_SESSION_PK ?? generatePrivateKey()) as `0x${string}`;
    const client = createClient({ chains: [CELO], agentIdentity: false });
    const admin = signerFromPrivateKey(opts.adminPk);
    const sessionSigner = signerFromPrivateKey(sessionPk);
    const wallet = await client.createWallet({ signer: admin });
    const transferData = appendAttributionSuffix(
      encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [wallet.address, fundUnits],
      }),
    );
    const expiry = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
    const permissions = sessionPermissions(opts.payGuard);

    if (opts.dry) {
      printDryCall("createWallet", { admin: adminAccount.address, buyerWallet: wallet.address });
      printDryCall("fund_usdc", {
        token: CELO_MAINNET_USDC,
        from: MAINNET_ADMIN_ADDRESS,
        to: wallet.address,
        amount: fundUnits.toString(),
        data: transferData,
      });
      printDryCall("grantSession", {
        chainId: CELO_MAINNET_CHAIN_ID,
        payGuard: opts.payGuard,
        permissions,
        expiry,
        feeToken: CELO_MAINNET_USDC,
        selector: formatPayGuardSelector(),
      });
      try {
        const quote = await client.quoteGrantSession({
          wallet,
          signer: admin,
          sessionSigner,
          chainId: CELO_MAINNET_CHAIN_ID,
          feeToken: CELO_MAINNET_USDC,
          permissions,
          expiry,
        });
        printDryCall("quoteGrantSession", { status: quote.status, legs: quote.legs?.length ?? 0 });
      } catch (err) {
        printDryCall("quoteGrantSession", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      printDryCall("persist", {
        sessionKeyFile: SESSION_KEY_PATH,
        sessionMetaFile: SESSION_META_PATH,
      });
      return;
    }

    const walletClient = createWalletClient({
      account: adminAccount,
      chain: celo,
      transport: http(runtime.rpc),
    });
    // Altana wallets are the admin EOA itself (EIP-7702), so there is nothing to fund when the addresses match.
    if (wallet.address.toLowerCase() !== adminAccount.address.toLowerCase()) {
      const fundHash = await walletClient.sendTransaction({
        to: CELO_MAINNET_USDC,
        data: transferData as Hex,
      });
      appendTxRow(`${stepId}_fund`, fundHash, `admin USDC fund ${fundUnits} units → buyer wallet`);
    }

    const grant = await client.grantSession({
      wallet,
      signer: admin,
      sessionSigner,
      chainId: CELO_MAINNET_CHAIN_ID,
      feeToken: CELO_MAINNET_USDC,
      permissions,
      expiry,
    });
    persistSessionKey(sessionPk, grant, wallet.address);
    if (grant.transactionHash) {
      appendTxRow(stepId, grant.transactionHash, "grantSession PayGuard.payWithPermit cap 1 USDC/day");
    }
    console.log(`buyer_wallet=${wallet.address} session→.secrets/session.key`);
    return;
  }

  const { client, session, walletAddress } = loadBuyerSession(opts.adminPk);

  if (stepId === "demo_allow_payment") {
    if (guardOnce) assertStepNotDone(stepId);
    assertMainnetDemoAmount(MAINNET_DEMO_PAYMENT_UNITS);
    const seller = await resolveMainnetSellerPayTo();
    assertSellerNotAdmin(seller.payTo);
    upsertRunMetadata("demo_seller_payto", seller.payTo);
    upsertRunMetadata("demo_seller_source", seller.source);

    if (opts.dry) {
      const tagged = buildPayWithPermitCalldata({
        payGuard: opts.payGuard,
        payTo: seller.payTo,
        token: CELO_MAINNET_USDC,
        amount: MAINNET_DEMO_PAYMENT_UNITS,
        verdict: 1,
      });
      printDryCall("demo_allow_payment", {
        payTo: seller.payTo,
        sellerUrl: seller.sellerUrl,
        amount: MAINNET_DEMO_PAYMENT_UNITS.toString(),
        data: tagged,
      });
      try {
        const quote = await client.quoteExecute({
          session,
          calls: [{ to: opts.payGuard, data: tagged }],
          chainId: CELO_MAINNET_CHAIN_ID,
          feeToken: CELO_MAINNET_USDC,
        });
        printDryCall("quoteExecute", { quote });
      } catch (e) {
        printDryCall("quoteExecute", { error: String(e) });
      }
      return;
    }

    const selfAgent = new SelfAgent({
      privateKey: opts.selfAgentPk,
      network: "mainnet",
      rpcUrl: runtime.rpc,
    });
    const oracle = await fetchOraclePermit(
      selfAgent,
      opts.vetgateUrl,
      seller.payTo,
      walletAddress,
      seller.sellerUrl,
    );
    if (oracle.verdict !== "ALLOW" || !oracle.permit) {
      throw new Error(`oracle refused ALLOW for seller (${seller.source})`);
    }
    const exec = await executeSessionPayWithPermit({
      client,
      session,
      payGuard: opts.payGuard,
      permit: oracle.permit,
      amountUnits: MAINNET_DEMO_PAYMENT_UNITS,
    });
    appendTxRow(stepId, exec.transactionHash, `ALLOW payWithPermit ${seller.source} → ${seller.payTo}`);
    return;
  }

  if (stepId === "demo_block_revert") {
    if (guardOnce) assertStepNotDone(stepId);
    const seller = await resolveMainnetSellerPayTo();
    const tagged = buildPayWithPermitCalldata({
      payGuard: opts.payGuard,
      payTo: seller.payTo,
      token: CELO_MAINNET_USDC,
      amount: MAINNET_DEMO_PAYMENT_UNITS,
      verdict: 0,
    });

    if (opts.dry) {
      printDryCall("demo_block_revert", {
        data: tagged,
        gasCap: (opts.blockGasCap ?? DEFAULT_BLOCK_GAS).toString(),
      });
      await publicClient()
        .call({
          account: walletAddress,
          to: opts.payGuard,
          data: tagged,
          gas: opts.blockGasCap ?? DEFAULT_BLOCK_GAS,
        })
        .then(() => printDryCall("eth_call", { unexpected: "did not revert" }))
        .catch((e) => printDryCall("eth_call", { revert: String(e) }));
      return;
    }

    try {
      const exec = await client.execute({
        session,
        calls: [{ to: opts.payGuard, data: tagged }],
        chainId: CELO_MAINNET_CHAIN_ID,
        feeToken: CELO_MAINNET_USDC,
      });
      appendTxRow(stepId, exec.transactionHash ?? "0x0", "unexpected success (expected revert)");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendTxRow(stepId, "0xrevert", `BLOCK revert visible: ${msg.slice(0, 120)}`);
      console.log(`demo_block_revert: on-chain revert (${msg.slice(0, 200)})`);
    }
    return;
  }

  if (stepId === "revoke_session") {
    if (guardOnce) assertStepNotDone(stepId);
    const admin = signerFromPrivateKey(opts.adminPk);
    const wallet = { address: walletAddress };
    if (opts.dry) {
      const quote = await client.quoteRevokeSession({
        wallet,
        signer: admin,
        session,
        chainId: CELO_MAINNET_CHAIN_ID,
        feeToken: CELO_MAINNET_USDC,
      });
      printDryCall("revokeSession", { status: quote.status });
      const probe = buildPayWithPermitCalldata({
        payGuard: opts.payGuard,
        payTo: MAINNET_ADMIN_ADDRESS,
        token: CELO_MAINNET_USDC,
        amount: 1n,
        verdict: 1,
      });
      await client
        .quoteExecute({
          session,
          calls: [{ to: opts.payGuard, data: probe }],
          chainId: CELO_MAINNET_CHAIN_ID,
          feeToken: CELO_MAINNET_USDC,
        })
        .then(() => printDryCall("post_revoke_quote", { unexpected: "quote succeeded" }))
        .catch((e) => printDryCall("post_revoke_quote", { expectFail: String(e) }));
      return;
    }

    const revoked = await client.revokeSession({
      wallet,
      signer: admin,
      session,
      chainId: CELO_MAINNET_CHAIN_ID,
      feeToken: CELO_MAINNET_USDC,
    });
    if (revoked.transactionHash) {
      appendTxRow(stepId, revoked.transactionHash, "revokeSession");
    }
    const probe = buildPayWithPermitCalldata({
      payGuard: opts.payGuard,
      payTo: MAINNET_ADMIN_ADDRESS,
      token: CELO_MAINNET_USDC,
      amount: 1n,
      verdict: 1,
    });
    try {
      await client.quoteExecute({
        session,
        calls: [{ to: opts.payGuard, data: probe }],
        chainId: CELO_MAINNET_CHAIN_ID,
        feeToken: CELO_MAINNET_USDC,
      });
      console.log("post_revoke: quote unexpectedly succeeded");
    } catch (err) {
      console.log(`post_revoke simulate refused: ${err instanceof Error ? err.message : err}`);
    }
    return;
  }

  if (stepId === "daily_small_use") {
    if (!opts.daily) {
      console.log("Pass --daily to run one idempotent ALLOW payment for the current UTC day.");
      return;
    }
    const day = utcDayStamp();
    if (isDailyPaymentDoneUtc(day)) {
      console.log(`daily_small_use: skip — already recorded for UTC ${day}`);
      return;
    }
    assertMainnetDemoAmount(MAINNET_DEMO_PAYMENT_UNITS);
    const seller = await resolveMainnetSellerPayTo();
    assertSellerNotAdmin(seller.payTo);

    if (opts.dry) {
      printDryCall("daily_small_use", { utcDay: day, amount: MAINNET_DEMO_PAYMENT_UNITS.toString() });
      return;
    }

    if (isStepDone("revoke_session")) {
      throw new Error("daily_small_use: session revoked — re-run step 3 first");
    }

    const selfAgent = new SelfAgent({
      privateKey: opts.selfAgentPk,
      network: "mainnet",
      rpcUrl: runtime.rpc,
    });
    const oracle = await fetchOraclePermit(
      selfAgent,
      opts.vetgateUrl,
      seller.payTo,
      walletAddress,
      seller.sellerUrl,
    );
    if (oracle.verdict !== "ALLOW" || !oracle.permit) {
      throw new Error("daily payment: oracle did not ALLOW");
    }
    const exec = await executeSessionPayWithPermit({
      client,
      session,
      payGuard: opts.payGuard,
      permit: oracle.permit,
      amountUnits: MAINNET_DEMO_PAYMENT_UNITS,
    });
    appendTxRow(stepId, exec.transactionHash, `daily ALLOW utc=${day}`);
    return;
  }

  throw new Error(`Unhandled step ${stepId satisfies never}`);
}

export function formatPayGuardSelector(): string {
  return toFunctionSelector(PAY_WITH_PERMIT_CALL_SIG);
}