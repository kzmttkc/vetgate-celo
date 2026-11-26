import { createPublicClient, http, parseAbiItem } from "viem";

import { CELO_MAINNET_CHAIN_ID, CELO_MAINNET_RPC, resolveCeloRuntime } from "./chain.js";

/** VetGatePayGuard on Celo mainnet (42220), see MAINNET_RUN.md deploy_pay_guard. */
export const MAINNET_PAY_GUARD_ADDRESS =
  "0xde00a2f23792e3cadbf0088a1b93276748a5666c" as const;
/** Block of the PayGuard CREATE tx (0x3e15259a…f0b8). */
export const MAINNET_PAY_GUARD_DEPLOY_BLOCK = 83529645n;
/** forno.celo.org rejects eth_getLogs over 5000 blocks ("max block range 5000"). */
export const DEFAULT_LOG_CHUNK_BLOCKS = 5000n;
export const DEFAULT_ONCHAIN_TTL_MS = 60_000;

export const GUARDED_PAYMENT_EVENT = parseAbiItem(
  "event GuardedPayment(address indexed buyer, address indexed payTo, address indexed token, uint256 amount, bytes32 nonce)",
);

export type GuardedPaymentLog = {
  buyer: string;
  payTo: string;
  token: string;
  amount: bigint;
  blockNumber: bigint;
};

export type OnchainReader = {
  getBlockNumber(): Promise<bigint>;
  /** Inclusive block range; callers keep toBlock - fromBlock < chunk size. */
  getGuardedPaymentLogs(fromBlock: bigint, toBlock: bigint): Promise<GuardedPaymentLog[]>;
};

export type OnchainBucket = {
  payments: number;
  /** Raw token units (no decimals applied), keyed by lowercase token address. */
  amount: Record<string, string>;
  payers: number;
};

export type OnchainSnapshot = OnchainBucket & {
  chainId: number;
  payGuard: string;
  event: "GuardedPayment";
  team: OnchainBucket;
  independent: OnchainBucket;
  fromBlock: string;
  toBlock: string;
  asOf: string;
};

export type OnchainError = { error: "rpc_unavailable" };

export function createViemOnchainReader(
  rpcUrl: string,
  payGuard: `0x${string}`,
): OnchainReader {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 2 }) });
  return {
    getBlockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    async getGuardedPaymentLogs(fromBlock, toBlock) {
      const logs = await client.getLogs({
        address: payGuard,
        event: GUARDED_PAYMENT_EVENT,
        fromBlock,
        toBlock,
        strict: true,
      });
      return logs.map((l) => ({
        buyer: l.args.buyer,
        payTo: l.args.payTo,
        token: l.args.token,
        amount: l.args.amount,
        blockNumber: l.blockNumber,
      }));
    },
  };
}

/** Mainnet RPC: CELO_RPC_URL when the runtime is mainnet, otherwise forno mainnet. */
export function resolveMainnetRpc(): string {
  const runtime = resolveCeloRuntime();
  return runtime.network === "mainnet" ? runtime.rpc : CELO_MAINNET_RPC;
}

function summarize(logs: readonly GuardedPaymentLog[]): OnchainBucket {
  const amount = new Map<string, bigint>();
  const payers = new Set<string>();
  for (const l of logs) {
    const token = l.token.toLowerCase();
    amount.set(token, (amount.get(token) ?? 0n) + l.amount);
    payers.add(l.buyer.toLowerCase());
  }
  return {
    payments: logs.length,
    amount: Object.fromEntries([...amount].map(([k, v]) => [k, v.toString()])),
    payers: payers.size,
  };
}

export type OnchainStatsOptions = {
  reader: OnchainReader;
  teamWallets: ReadonlySet<string>;
  payGuard?: string;
  chainId?: number;
  fromBlock?: bigint;
  chunkBlocks?: bigint;
  ttlMs?: number;
  concurrency?: number;
  now?: () => number;
};

/**
 * Counts PayGuard GuardedPayment events from the deploy block to the chain head.
 * Logs are kept in memory and only the new block range is read on refresh; the
 * whole result is cached for ttlMs. Any RPC failure yields { error } (never zeros).
 */
export class OnchainStats {
  private readonly reader: OnchainReader;
  private readonly teamWallets: ReadonlySet<string>;
  private readonly payGuard: string;
  private readonly chainId: number;
  private readonly fromBlock: bigint;
  private readonly chunkBlocks: bigint;
  private readonly ttlMs: number;
  private readonly concurrency: number;
  private readonly now: () => number;

  private logs: GuardedPaymentLog[] = [];
  private scannedTo: bigint;
  private cached: { at: number; value: OnchainSnapshot } | null = null;
  private inflight: Promise<OnchainSnapshot | OnchainError> | null = null;

  constructor(opts: OnchainStatsOptions) {
    this.reader = opts.reader;
    this.teamWallets = opts.teamWallets;
    this.payGuard = (opts.payGuard ?? MAINNET_PAY_GUARD_ADDRESS).toLowerCase();
    this.chainId = opts.chainId ?? CELO_MAINNET_CHAIN_ID;
    this.fromBlock = opts.fromBlock ?? MAINNET_PAY_GUARD_DEPLOY_BLOCK;
    this.chunkBlocks = opts.chunkBlocks ?? DEFAULT_LOG_CHUNK_BLOCKS;
    this.ttlMs = opts.ttlMs ?? DEFAULT_ONCHAIN_TTL_MS;
    this.concurrency = Math.max(1, opts.concurrency ?? 8);
    this.now = opts.now ?? Date.now;
    this.scannedTo = this.fromBlock - 1n;
  }

  async snapshot(): Promise<OnchainSnapshot | OnchainError> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.value;
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async refresh(): Promise<OnchainSnapshot | OnchainError> {
    try {
      const head = await this.reader.getBlockNumber();
      const ranges: Array<[bigint, bigint]> = [];
      for (let start = this.scannedTo + 1n; start <= head; start += this.chunkBlocks) {
        const end = start + this.chunkBlocks - 1n;
        ranges.push([start, end > head ? head : end]);
      }
      const results: GuardedPaymentLog[][] = new Array(ranges.length);
      let next = 0;
      const worker = async () => {
        while (next < ranges.length) {
          const i = next++;
          const [a, b] = ranges[i]!;
          results[i] = await this.reader.getGuardedPaymentLogs(a, b);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(this.concurrency, ranges.length) }, worker),
      );
      // Commit only after every chunk succeeded so a partial read never shows as a total.
      this.logs = this.logs.concat(results.flat());
      if (head > this.scannedTo) this.scannedTo = head;

      const team = this.logs.filter((l) => this.teamWallets.has(l.buyer.toLowerCase()));
      const independent = this.logs.filter((l) => !this.teamWallets.has(l.buyer.toLowerCase()));
      const value: OnchainSnapshot = {
        chainId: this.chainId,
        payGuard: this.payGuard,
        event: "GuardedPayment",
        ...summarize(this.logs),
        team: summarize(team),
        independent: summarize(independent),
        fromBlock: this.fromBlock.toString(),
        toBlock: this.scannedTo.toString(),
        asOf: new Date(this.now()).toISOString(),
      };
      this.cached = { at: this.now(), value };
      return value;
    } catch {
      return { error: "rpc_unavailable" };
    }
  }
}
