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

import {
  attributedExecute,
  attributedGrantSession,
  attributedQuoteGrantSession,
  attributedQuoteRevokeSession,
  attributedRevokeSession,
  ensureRelayAttributionSuffix,
  tagRelayCalls,
} from "./attributed-altana-client.js";
import { appendAttributionSuffix } from "./attribution.js";
import {
  buildTaggedPayWithPermitCalldata,
  executeSessionPayWithPermit,
  fetchOraclePermit,
} from "./agent-buyer.js";
import { isAltanaError } from "@altananetwork/sdk";
import {
  CELO_MAINNET_CHAIN_ID,
  CELO_MAINNET_USDC,
  MAINNET_ADMIN_ADDRESS,
  MAINNET_ALTANA_ADMIN_ADDRESS,
  MAINNET_CONTROLLED_SELLER_NOTE,
  resolveAttributionCode,
  resolveCeloRuntime,
} from "./chain.js";
import { printRelayQuote } from "./mainnet-quote.js";
import { mintVetGatePermit } from "./permit.js";
import type { OraclePermitFields } from "./agent-buyer.js";
import {
  appendTxRow,
  assertStepNotDone,
  isDailyPaymentDoneUtc,
  isStepDone,
  markTxRowSuperseded,
  MAINNET_EXISTING_ERC8004_AGENT_ID,
  SESSION_KEY_PATH,
  SESSION_META_PATH,
  upsertRunMetadata,
  utcDayStamp,
} from "./mainnet-run-log.js";
import {
  assertMainnetDemoAmount,
  assertSellerNotAdmin,
  MAINNET_DAILY_USDC_APPROVE_CAP,
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
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
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
  /** Oracle / Self / ERC-8004 admin (0x970b…). */
  oraclePk: `0x${string}`;
  /** Altana buyer-wallet admin — never-used EOA (0xCDb0…). */
  altanaPk: `0x${string}`;
  vetgateUrl: string;
  selfAgentPk: `0x${string}`;
  fundUsdcUnits?: bigint;
  blockGasCap?: bigint;
};

const DEFAULT_FUND_UNITS = 200_000n;
/** Fixed gas for on-chain BLOCK demo from Altana admin EOA (verdict revert must land on chain). */
export const BLOCK_DIRECT_GAS = 200_000n;
const DEFAULT_BLOCK_GAS = BLOCK_DIRECT_GAS;

export function assertMainnetChain(allowTestnet: boolean): void {
  const runtime = resolveCeloRuntime();
  if (runtime.chainId !== CELO_MAINNET_CHAIN_ID && !allowTestnet) {
    throw new Error(
      `refused: chainId ${runtime.chainId} (set VETGATE_CELO_NETWORK=mainnet or pass --testnet)`,
    );
  }
}

export { syncVetgateCeloNetworkEnv as syncNetworkEnvFromAlias } from "./chain.js";

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

/** Gas used by mainnet demo_allow_payment payWithPermit (allowance already set). */
const REFERENCE_PAY_WITH_PERMIT_GAS = 229_254n;

async function printDryEoaTx(
  label: string,
  from: `0x${string}`,
  to: `0x${string}`,
  data: Hex,
  opts?: { gasFallback?: bigint },
): Promise<void> {
  printDryCall(label, { from, to, data });
  const gas = await publicClient()
    .estimateGas({ account: from, to, data })
    .catch(() => undefined);
  if (gas !== undefined) {
    printDryCall(`${label}_estimateGas`, { gas: gas.toString() });
    return;
  }
  if (opts?.gasFallback !== undefined) {
    printDryCall(`${label}_estimateGas`, {
      gas: opts.gasFallback.toString(),
      source: "reference (rpc cannot simulate before approve)",
    });
  }
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

function buildUsdcApproveForGuardCalldata(
  payGuard: `0x${string}`,
  amount: bigint,
): Hex {
  return appendAttributionSuffix(
    encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [payGuard, amount],
    }),
  );
}

async function readUsdcAllowance(
  owner: `0x${string}`,
  spender: `0x${string}`,
): Promise<bigint> {
  return await publicClient().readContract({
    address: CELO_MAINNET_USDC,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, spender],
  });
}

async function ensurePayGuardUsdcAllowance(params: {
  client: Client;
  altanaPk: `0x${string}`;
  payGuard: `0x${string}`;
  walletAddress: `0x${string}`;
  amount: bigint;
  dry: boolean;
}): Promise<void> {
  const allowance = await readUsdcAllowance(params.walletAddress, params.payGuard);
  if (allowance >= params.amount) return;

  const altanaSigner = signerFromPrivateKey(params.altanaPk);
  const wallet = { address: params.walletAddress };
  const approveTagged = buildUsdcApproveForGuardCalldata(params.payGuard, params.amount);
  printDryCall("usdc_approve_pay_guard", {
    owner: params.walletAddress,
    spender: params.payGuard,
    amount: params.amount.toString(),
    priorAllowance: allowance.toString(),
    data: approveTagged,
  });
  if (params.dry) return;
  const approved = await attributedExecute(params.client, {
    wallet,
    signer: altanaSigner,
    calls: tagRelayCalls([{ to: CELO_MAINNET_USDC, data: approveTagged }]),
    chainId: CELO_MAINNET_CHAIN_ID,
    feeToken: CELO_MAINNET_USDC,
  });
  if (approved.transactionHash) {
    appendTxRow("usdc_approve_pay_guard", approved.transactionHash, `USDC approve PayGuard ${params.amount} units`);
  }
}

async function resolveOraclePermitForPayment(opts: {
  dry: boolean;
  selfAgentPk: `0x${string}`;
  vetgateUrl: string;
  payGuard: `0x${string}`;
  oraclePk: `0x${string}`;
  seller: Awaited<ReturnType<typeof resolveMainnetSellerPayTo>>;
  walletAddress: `0x${string}`;
  runtime: ReturnType<typeof resolveCeloRuntime>;
}): Promise<OraclePermitFields> {
  const selfAgent = new SelfAgent({
    privateKey: opts.selfAgentPk,
    network: "mainnet",
    rpcUrl: opts.runtime.rpc,
  });
  const oracle = await fetchOraclePermit(
    selfAgent,
    opts.vetgateUrl,
    opts.seller.payTo,
    opts.walletAddress,
    opts.seller.sellerUrl,
  );
  if (oracle.verdict === "ALLOW" && oracle.permit) {
    return oracle.permit;
  }
  if (opts.dry && opts.seller.source === "vet402") {
    printDryCall("oracle_permit", {
      note: "HTTP permit unavailable (quota/402); minting dry quote permit locally after vet402 ALLOW",
    });
    const oracleAccount = privateKeyToAccount(opts.oraclePk);
    return await mintVetGatePermit({
      buyer: opts.walletAddress,
      payTo: opts.seller.payTo,
      maxAmount: 1_000_000n,
      payGuardAddress: opts.payGuard,
      oracleAccount,
      token: CELO_MAINNET_USDC,
    });
  }
  throw new Error(`oracle refused ALLOW for seller (${opts.seller.source})`);
}

function logAltanaQuoteFailure(label: string, err: unknown): void {
  if (isAltanaError(err)) {
    const parts = [
      err.message,
      err.code ? `code=${err.code}` : "",
      err.detail ? `detail=${err.detail}` : "",
      err.relayMessage ? `relay=${err.relayMessage}` : "",
    ].filter(Boolean);
    printDryCall(label, { error: parts.join(" | ") });
    return;
  }
  printDryCall(label, { error: err instanceof Error ? err.message : String(err) });
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

function loadBuyerSessionFromDisk(): {
  session: Session;
  walletAddress: `0x${string}`;
  sessionPk: `0x${string}`;
} {
  const sessionPk = readFileSync(SESSION_KEY_PATH, "utf8").trim() as `0x${string}`;
  const stored = JSON.parse(readFileSync(SESSION_META_PATH, "utf8")) as ReturnType<
    typeof serializeSession
  >;
  const sessionSigner = signerFromPrivateKey(sessionPk);
  const session = deserializeSession(stored, sessionSigner);
  return { session, walletAddress: stored.walletAddress, sessionPk };
}

function buyerClient(): Client {
  return createClient({ chains: [CELO], agentIdentity: false });
}

function loadBuyerSession(): {
  client: Client;
  session: Session;
  walletAddress: `0x${string}`;
} {
  const { session, walletAddress } = loadBuyerSessionFromDisk();
  return { client: buyerClient(), session, walletAddress };
}

export async function runMainnetStep(
  stepId: MainnetRunStepId,
  opts: MainnetRunOptions,
): Promise<void> {
  assertMainnetChain(opts.allowTestnet);
  await ensureRelayAttributionSuffix();
  const runtime = resolveCeloRuntime();
  const oracleAccount = privateKeyToAccount(opts.oraclePk);
  const altanaAccount = privateKeyToAccount(opts.altanaPk);
  if (altanaAccount.address.toLowerCase() !== MAINNET_ALTANA_ADMIN_ADDRESS.toLowerCase()) {
    throw new Error(
      `refused: Altana admin must be ${MAINNET_ALTANA_ADMIN_ADDRESS} (got ${altanaAccount.address})`,
    );
  }
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
      account: oracleAccount,
      chain: celo,
      transport: http(runtime.rpc),
    });
    const data = buildDeployPayGuardCalldata(oracleAccount.address);
    const hash = await walletClient.sendTransaction({ data, value: 0n });
    appendTxRow(stepId, hash, "PayGuard CREATE + ERC-8021 suffix");
    return;
  }

  if (stepId === "register_erc8004_seller") {
    if (await erc8004SkipRegister(oracleAccount.address)) {
      console.log(`skip: already ${MAINNET_EXISTING_ERC8004_AGENT_ID}`);
      if (!isStepDone(stepId)) {
        appendTxRow(stepId, "0xskipped", `skip: already ${MAINNET_EXISTING_ERC8004_AGENT_ID}`);
      }
      return;
    }
    if (guardOnce) assertStepNotDone(stepId);
    const client = createClient({ chains: [CELO], agentIdentity: false });
    const admin = signerFromPrivateKey(opts.oraclePk);
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
    const result = await attributedExecute(client, {
      wallet,
      signer: admin,
      chainId: CELO_MAINNET_CHAIN_ID,
      calls: tagRelayCalls([{ to: call.to, data: tagged }]),
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
    const altanaSigner = signerFromPrivateKey(opts.altanaPk);
    const sessionSigner = signerFromPrivateKey(sessionPk);
    const wallet = await client.createWallet({ signer: altanaSigner });
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
      printDryCall("createWallet", {
        altanaAdmin: altanaAccount.address,
        buyerWallet: wallet.address,
      });
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
        const quote = await attributedQuoteGrantSession(client, {
          wallet,
          signer: altanaSigner,
          sessionSigner,
          chainId: CELO_MAINNET_CHAIN_ID,
          feeToken: CELO_MAINNET_USDC,
          permissions,
          expiry,
        });
        printRelayQuote("quoteGrantSession", quote);
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
      account: oracleAccount,
      chain: celo,
      transport: http(runtime.rpc),
    });
    // Altana wallets are the admin EOA itself (EIP-7702), so there is nothing to fund when the addresses match.
    if (wallet.address.toLowerCase() !== altanaAccount.address.toLowerCase()) {
      const fundHash = await walletClient.sendTransaction({
        to: CELO_MAINNET_USDC,
        data: transferData as Hex,
      });
      appendTxRow(`${stepId}_fund`, fundHash, `admin USDC fund ${fundUnits} units → buyer wallet`);
    }

    const grant = await attributedGrantSession(client, {
      wallet,
      signer: altanaSigner,
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
    if (oracleAccount.address.toLowerCase() !== MAINNET_ADMIN_ADDRESS.toLowerCase()) {
      throw new Error(
        `daily_small_use: operator EOA must be ${MAINNET_ADMIN_ADDRESS} (got ${oracleAccount.address})`,
      );
    }
    assertMainnetDemoAmount(MAINNET_DEMO_PAYMENT_UNITS);
    const seller = await resolveMainnetSellerPayTo();
    if (seller.source !== "vet402") {
      console.log(`daily_small_use: skipped: not ALLOW utc=${day}`);
      return;
    }
    assertSellerNotAdmin(seller.payTo);
    upsertRunMetadata("demo_seller_payto", seller.payTo);
    upsertRunMetadata("demo_seller_source", seller.source);

    const minted = await mintVetGatePermit({
      buyer: oracleAccount.address,
      payTo: seller.payTo,
      maxAmount: MAINNET_DEMO_PAYMENT_UNITS,
      payGuardAddress: opts.payGuard,
      oracleAccount,
      token: CELO_MAINNET_USDC,
    });
    const permit: OraclePermitFields = {
      payTo: minted.payTo,
      token: minted.token,
      maxAmount: minted.maxAmount,
      expiresAt: minted.expiresAt,
      nonce: minted.nonce,
      verdictCode: minted.verdictCode,
      signature: minted.signature,
    };
    const taggedPay = buildTaggedPayWithPermitCalldata({
      permit,
      amountUnits: MAINNET_DEMO_PAYMENT_UNITS,
    });
    const operator = oracleAccount.address;
    const allowance = await readUsdcAllowance(operator, opts.payGuard);
    const needsApprove = allowance < MAINNET_DEMO_PAYMENT_UNITS;
    const approveTagged = needsApprove
      ? buildUsdcApproveForGuardCalldata(opts.payGuard, MAINNET_DAILY_USDC_APPROVE_CAP)
      : undefined;

    if (opts.dry) {
      printDryCall("daily_small_use", {
        utcDay: day,
        mode: "operator_eoa_direct",
        from: operator,
        sellerUrl: seller.sellerUrl,
        payTo: seller.payTo,
        amount: MAINNET_DEMO_PAYMENT_UNITS.toString(),
        usdcAllowance: allowance.toString(),
        approveCap: MAINNET_DAILY_USDC_APPROVE_CAP.toString(),
        payGuard: opts.payGuard,
        oraclePermit: "minted locally after vet402 ALLOW",
      });
      if (approveTagged) {
        await printDryEoaTx("daily_usdc_approve", operator, CELO_MAINNET_USDC, approveTagged);
      }
      await printDryEoaTx("daily_pay_with_permit", operator, opts.payGuard, taggedPay, {
        gasFallback: needsApprove ? REFERENCE_PAY_WITH_PERMIT_GAS : undefined,
      });
      return;
    }

    const walletClient = createWalletClient({
      account: oracleAccount,
      chain: celo,
      transport: http(runtime.rpc),
    });
    if (approveTagged) {
      const approveHash = await walletClient.sendTransaction({
        to: CELO_MAINNET_USDC,
        data: approveTagged,
      });
      appendTxRow(
        "usdc_approve_pay_guard",
        approveHash,
        `operator USDC approve PayGuard cap ${MAINNET_DAILY_USDC_APPROVE_CAP} units (daily)`,
      );
    }
    const payHash = await walletClient.sendTransaction({
      to: opts.payGuard,
      data: taggedPay,
    });
    appendTxRow(
      stepId,
      payHash,
      `daily operator ALLOW payWithPermit ${seller.source} utc=${day} → ${seller.payTo}`,
    );
    return;
  }

  const { client, session, walletAddress } = loadBuyerSession();

  if (stepId === "demo_allow_payment") {
    if (guardOnce) assertStepNotDone(stepId);
    assertMainnetDemoAmount(MAINNET_DEMO_PAYMENT_UNITS);
    const seller = await resolveMainnetSellerPayTo();
    assertSellerNotAdmin(seller.payTo);
    upsertRunMetadata("demo_seller_payto", seller.payTo);
    upsertRunMetadata("demo_seller_source", seller.source);
    if (seller.source === "controlled") {
      upsertRunMetadata("demo_seller_note", MAINNET_CONTROLLED_SELLER_NOTE);
    }

    if (opts.dry) {
      const permit = await resolveOraclePermitForPayment({
        dry: true,
        selfAgentPk: opts.selfAgentPk,
        vetgateUrl: opts.vetgateUrl,
        payGuard: opts.payGuard,
        oraclePk: opts.oraclePk,
        seller,
        walletAddress,
        runtime,
      });
      const tagged = buildTaggedPayWithPermitCalldata({
        permit,
        amountUnits: MAINNET_DEMO_PAYMENT_UNITS,
      });
      const approveTagged = buildUsdcApproveForGuardCalldata(
        opts.payGuard,
        MAINNET_DEMO_PAYMENT_UNITS,
      );
      const allowance = await readUsdcAllowance(walletAddress, opts.payGuard);
      printDryCall("demo_allow_payment", {
        payTo: seller.payTo,
        sellerUrl: seller.sellerUrl,
        amount: MAINNET_DEMO_PAYMENT_UNITS.toString(),
        usdcAllowance: allowance.toString(),
        data: tagged,
      });
      const altanaSigner = signerFromPrivateKey(opts.altanaPk);
      const wallet = { address: walletAddress };
      try {
        if (allowance < MAINNET_DEMO_PAYMENT_UNITS) {
          printDryCall("quote_plan", {
            note: "USDC allowance 0 → quote admin bundle approve+payWithPermit (live: approve tx then session payWithPermit)",
          });
          const quote = await client.quoteExecute({
            wallet,
            signer: altanaSigner,
            calls: [
              { to: CELO_MAINNET_USDC, data: approveTagged },
              { to: opts.payGuard, data: tagged },
            ],
            chainId: CELO_MAINNET_CHAIN_ID,
            feeToken: CELO_MAINNET_USDC,
          });
          printRelayQuote("quoteExecute", quote);
        } else {
          const quote = await client.quoteExecute({
            session,
            calls: [{ to: opts.payGuard, data: tagged }],
            chainId: CELO_MAINNET_CHAIN_ID,
            feeToken: CELO_MAINNET_USDC,
          });
          printRelayQuote("quoteExecute", quote);
        }
      } catch (e) {
        logAltanaQuoteFailure("quoteExecute", e);
      }
      return;
    }

    const permit = await resolveOraclePermitForPayment({
      dry: false,
      selfAgentPk: opts.selfAgentPk,
      vetgateUrl: opts.vetgateUrl,
      payGuard: opts.payGuard,
      oraclePk: opts.oraclePk,
      seller,
      walletAddress,
      runtime,
    });
    await ensurePayGuardUsdcAllowance({
      client,
      altanaPk: opts.altanaPk,
      payGuard: opts.payGuard,
      walletAddress,
      amount: MAINNET_DEMO_PAYMENT_UNITS,
      dry: false,
    });
    const exec = await executeSessionPayWithPermit({
      client,
      session,
      payGuard: opts.payGuard,
      permit,
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
    const gasLimit = opts.blockGasCap ?? DEFAULT_BLOCK_GAS;

    if (opts.dry) {
      printDryCall("demo_block_revert", {
        mode: "direct_eoa",
        from: walletAddress,
        to: opts.payGuard,
        data: tagged,
        gas: gasLimit.toString(),
        note: "Altana admin EOA sendTransaction (expect VerdictNotAllow on chain)",
      });
      printDryCall("demo_block_revert", {
        data: tagged,
        gasCap: gasLimit.toString(),
      });
      try {
        const quote = await client.quoteExecute({
          session,
          calls: [{ to: opts.payGuard, data: tagged }],
          chainId: CELO_MAINNET_CHAIN_ID,
          feeToken: CELO_MAINNET_USDC,
        });
        printRelayQuote("quoteExecute", quote);
      } catch (e) {
        const relayMsg = isAltanaError(e) ? (e.relayMessage ?? e.detail ?? "") : String(e);
        if (relayMsg.includes("0x3e0a75f3") || relayMsg.includes("VerdictNotAllow")) {
          printDryCall("quoteExecute", {
            status: "expected_revert",
            reason: "relay will not quote a reverting payWithPermit (VerdictNotAllow)",
          });
        } else {
          logAltanaQuoteFailure("quoteExecute", e);
        }
      }
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

    markTxRowSuperseded("demo_block_revert", "0xrevert", "relay path did not land on chain");

    const walletClient = createWalletClient({
      account: altanaAccount,
      chain: celo,
      transport: http(runtime.rpc),
    });
    const hash = await walletClient.sendTransaction({
      to: opts.payGuard,
      data: tagged,
      gas: gasLimit,
      value: 0n,
    });
    const receipt = await publicClient().waitForTransactionReceipt({ hash });
    if (receipt.status === "success") {
      appendTxRow(stepId, hash, "unexpected success (expected VerdictNotAllow revert)");
      return;
    }
    appendTxRow(
      stepId,
      hash,
      "BLOCK direct EOA payWithPermit verdict=0 (VerdictNotAllow), gas=200000, ERC-8021 suffix",
    );
    console.log(`demo_block_revert: on-chain revert tx ${hash}`);
    return;
  }

  if (stepId === "revoke_session") {
    if (guardOnce) assertStepNotDone(stepId);
    const altanaSigner = signerFromPrivateKey(opts.altanaPk);
    const wallet = { address: walletAddress };
    if (opts.dry) {
      const quote = await attributedQuoteRevokeSession(client, {
        wallet,
        signer: altanaSigner,
        session,
        chainId: CELO_MAINNET_CHAIN_ID,
        feeToken: CELO_MAINNET_USDC,
      });
      printRelayQuote("quoteRevokeSession", quote);
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

    const revoked = await attributedRevokeSession(client, {
      wallet,
      signer: altanaSigner,
      session,
      chainId: CELO_MAINNET_CHAIN_ID,
      feeToken: CELO_MAINNET_USDC,
    });
    if (revoked.transactionHash) {
      appendTxRow(stepId, revoked.transactionHash, "revokeSession (+ ERC-8021 relay suffix)");
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

  throw new Error(`Unhandled step ${stepId satisfies never}`);
}

export function formatPayGuardSelector(): string {
  return toFunctionSelector(PAY_WITH_PERMIT_CALL_SIG);
}