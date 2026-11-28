import express, { type Express, type RequestHandler } from "express";
import { privateKeyToAccount } from "viem/accounts";
import { HEADERS, SelfAgentVerifier } from "@selfxyz/agent-sdk";
import {
  ERC8004_HEADERS,
  createCeloErc8004Reader,
  verifyErc8004Request,
  type Erc8004Agent,
  type Erc8004Reader,
} from "./erc8004-auth.js";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient, type RoutesConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

import {
  MAINNET_ADMIN_ADDRESS,
  MAINNET_ALTANA_ADMIN_ADDRESS,
  readPayGuardNonceUsed,
  resolveCeloRuntime,
} from "./chain.js";
import {
  DailyHumanQuota,
  deriveFreePermitNonce,
  FREE_QUOTA_SCOPE,
} from "./daily-quota.js";
import { mintVetGatePermit } from "./permit.js";
import {
  createViemOnchainReader,
  MAINNET_PAY_GUARD_ADDRESS,
  OnchainStats,
  resolveMainnetRpc,
} from "./onchain-stats.js";
import { parseTeamWallets, StatsStore } from "./stats.js";
import { fetchVet402Check, isVet402Allow } from "./vet402.js";

export type CreateAppConfig = {
  payTo: `0x${string}`;
  payGuardAddress: `0x${string}`;
  oraclePrivateKey: `0x${string}`;
  teamWalletsCsv?: string;
  x402ApiKey?: string;
  facilitatorUrl?: string;
  /** When false (default in tests), exhausted quota returns a synthetic 402 JSON instead of facilitator calls. */
  enableX402?: boolean;
  selfAuth?: RequestHandler;
  /** Reads ERC-8004 owner / agent wallet on Celo (agents without a Self Agent ID). */
  erc8004Reader?: Erc8004Reader;
  dailyQuota?: DailyHumanQuota;
  stats?: StatsStore;
  /** Celo mainnet PayGuard event counter for /v1/stats (tests inject a mocked reader). */
  onchainStats?: OnchainStats;
  vet402Fetch?: typeof fetch;
  /** Test override for PayGuard.usedNonces reads (production uses on-chain RPC). */
  readPayGuardNonceUsed?: (
    payGuard: `0x${string}`,
    nonce: `0x${string}`,
  ) => Promise<boolean>;
};

export type FreeQuotaInfo = {
  key: `0x${string}`;
  used: boolean;
  scope: typeof FREE_QUOTA_SCOPE;
};

export type PermitQuery = {
  payTo: string;
  buyer: string;
  sellerUrl: string;
  maxAmount: string;
};

function parsePermitQuery(req: express.Request): PermitQuery | null {
  const payTo = String(req.query.payTo ?? "");
  const buyer = String(req.query.buyer ?? "");
  const sellerUrl = String(req.query.sellerUrl ?? "");
  const maxAmount = String(req.query.maxAmount ?? "1000000");
  if (!payTo.startsWith("0x") || !buyer.startsWith("0x") || !sellerUrl.startsWith("https://")) {
    return null;
  }
  return { payTo, buyer, sellerUrl, maxAmount };
}

async function buildPermitResponse(
  cfg: CreateAppConfig,
  query: PermitQuery,
  tier: "free" | "paid",
  freeNonce?: `0x${string}`,
) {
  const fetchImpl = cfg.vet402Fetch ?? fetch;
  const vet402 = await fetchVet402Check(query.sellerUrl, fetchImpl);

  if (!isVet402Allow(vet402)) {
    return {
      status: 200 as const,
      body: {
        tier,
        verdict: vet402.recommendation ?? "BLOCK",
        vet402,
        permit: null,
        reason: "vet402 recommendation is not ALLOW. VetGate will not mint an onchain payment permit.",
      },
    };
  }

  const oracleAccount = privateKeyToAccount(cfg.oraclePrivateKey);
  const permit = await mintVetGatePermit({
    buyer: query.buyer as `0x${string}`,
    payTo: query.payTo as `0x${string}`,
    maxAmount: BigInt(query.maxAmount),
    payGuardAddress: cfg.payGuardAddress,
    oracleAccount,
    ...(tier === "free" && freeNonce ? { nonce: freeNonce } : {}),
  });

  const body: Record<string, unknown> = {
    tier,
    verdict: "ALLOW" as const,
    vet402,
    permit,
  };
  if (tier === "free" && freeNonce) {
    body.freeQuota = {
      key: freeNonce,
      used: false,
      scope: FREE_QUOTA_SCOPE,
    } satisfies FreeQuotaInfo;
  }

  return {
    status: 200 as const,
    body,
  };
}

export function createApp(cfg: CreateAppConfig): Express {
  const celo = resolveCeloRuntime();
  const teamWallets = parseTeamWallets(cfg.teamWalletsCsv);
  const dailyQuota = cfg.dailyQuota ?? new DailyHumanQuota();
  const stats = cfg.stats ?? new StatsStore(teamWallets);
  const onchainStats =
    cfg.onchainStats ??
    new OnchainStats({
      reader: createViemOnchainReader(resolveMainnetRpc(), MAINNET_PAY_GUARD_ADDRESS),
      // Operator buyers (oracle EOA and Altana buyer admin) are always team, plus VETGATE_TEAM_WALLETS.
      teamWallets: new Set([
        ...teamWallets,
        MAINNET_ADMIN_ADDRESS.toLowerCase(),
        MAINNET_ALTANA_ADMIN_ADDRESS.toLowerCase(),
      ]),
    });

  const useDefaultSelfAuth = !cfg.selfAuth;
  const selfAuth: RequestHandler =
    cfg.selfAuth ??
    (SelfAgentVerifier.create()
      .network(celo.selfNetwork)
      .sybilLimit(0)
      .requireAge(18)
      .requireOFAC()
      .build()
      .auth() as RequestHandler);

  const routes: RoutesConfig = {
    "GET /v1/permit": {
      accepts: {
        scheme: "exact",
        network: celo.caip2,
        payTo: cfg.payTo,
        price: {
          amount: "10000",
          asset: celo.usdc,
          extra: { name: "USDC", version: "2" },
        },
      },
      description:
        `VetGate Celo ${celo.network} oracle: vet402 seller check and EIP-712 VetGatePermit for VetGatePayGuard.`,
      mimeType: "application/json",
      extensions: declareDiscoveryExtension({
        input: {
          payTo: "0x000000000000000000000000000000000000dEaD",
          buyer: "0x000000000000000000000000000000000000bEEF",
          sellerUrl: "https://example.com/x402",
        },
        inputSchema: {
          properties: {
            payTo: { type: "string" },
            buyer: { type: "string" },
            sellerUrl: { type: "string" },
            maxAmount: { type: "string" },
          },
          required: ["payTo", "buyer", "sellerUrl"],
        },
        output: {
          example: {
            verdict: "ALLOW",
            permit: { verdictCode: 1, signature: "0x..." },
          },
        },
      }),
    },
  };

  const app = express();

  app.get("/health", (_req, res) => {
    res.status(200).json({
      ok: true,
      network: celo.network,
      chainId: celo.chainId,
    });
  });

  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  app.get("/v1/stats", async (_req, res) => {
    // stats: in-memory counters since this instance started (reset on redeploy).
    // onchain: Celo mainnet PayGuard GuardedPayment events since deploy (survives redeploys).
    const onchain = await onchainStats.snapshot();
    res.json({ network: celo.caip2, stats: stats.snapshot(), onchain });
  });

  let erc8004Reader: Erc8004Reader | undefined = cfg.erc8004Reader;
  app.use("/v1", async (req, res, next) => {
    if (req.path === "/stats") return next();
    const signature = req.headers[HEADERS.SIGNATURE];
    const timestamp = req.headers[HEADERS.TIMESTAMP];
    const ercId = req.headers[ERC8004_HEADERS.AGENT_ID];
    const ercSig = req.headers[ERC8004_HEADERS.SIGNATURE];
    const ercTs = req.headers[ERC8004_HEADERS.TIMESTAMP];
    if (typeof signature !== "string" && typeof ercId === "string") {
      // ERC-8004 path: an agent registered on Celo by another team, without a Self Agent ID.
      // It never gets the free human quota; every permit on this path is paid via x402.
      if (typeof ercSig !== "string" || typeof ercTs !== "string") {
        res.status(401).json({
          error: "erc8004_invalid",
          message: "Send x-erc8004-agent-id, x-erc8004-signature and x-erc8004-timestamp together.",
        });
        return;
      }
      erc8004Reader ??= createCeloErc8004Reader(celo.rpc);
      const result = await verifyErc8004Request({
        method: req.method,
        originalUrl: req.originalUrl,
        agentIdHeader: ercId,
        signature: ercSig,
        timestamp: ercTs,
        reader: erc8004Reader,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error, message: result.message });
        return;
      }
      (req as express.Request & { erc8004Agent?: Erc8004Agent }).erc8004Agent = result.agent;
      return next();
    }
    if (
      useDefaultSelfAuth &&
      (typeof signature !== "string" || typeof timestamp !== "string")
    ) {
      res.status(401).json({
        error: "self_agent_required",
        message:
          "Missing or invalid Self Agent ID request signature (x-self-agent-signature, x-self-agent-timestamp).",
      });
      return;
    }
    return selfAuth(req, res, (err) => {
      if (err) {
        res.status(403).json({
          error: "self_verification_failed",
          message:
            err instanceof Error
              ? err.message
              : "Self agent verification failed.",
        });
        return;
      }
      if (!req.agent) {
        res.status(401).json({
          error: "self_agent_required",
          message: "Missing or invalid Self Agent ID request signature (x-self-agent-signature, x-self-agent-timestamp).",
        });
        return;
      }
      next();
    });
  });

  const readNonceUsed = cfg.readPayGuardNonceUsed ?? readPayGuardNonceUsed;

  const synthetic402 = (res: express.Response, freeQuota?: FreeQuotaInfo) =>
    res.status(402).json({
      error: "x402_payment_required",
      message:
        `Daily free human quota exhausted. Pay $0.01 USDC on Celo ${celo.network} via x402 to continue.`,
      x402: routes["GET /v1/permit" as keyof RoutesConfig],
      network: celo.caip2,
      ...(freeQuota ? { freeQuota } : {}),
    });

  app.get("/v1/permit", async (req, res, next) => {
    const query = parsePermitQuery(req);
    if (!query) {
      return res.status(400).json({
        error: "invalid_query",
        message: "Required query params: payTo, buyer, sellerUrl (https URL).",
      });
    }

    (req as express.Request & { vetgateQuery?: PermitQuery }).vetgateQuery = query;
    (req as express.Request & { vetgateTier?: "free" | "paid" }).vetgateTier = "paid";
    if (!req.agent && (req as express.Request & { erc8004Agent?: Erc8004Agent }).erc8004Agent) {
      if (!cfg.enableX402 || !cfg.x402ApiKey) return synthetic402(res);
      return next();
    }
    const agent = req.agent!;
    const nullifier = agent.nullifier.toString();

    const freeNonce = deriveFreePermitNonce(nullifier);

    if (!dailyQuota.hasFreeSlot(nullifier)) {
      if (!cfg.enableX402 || !cfg.x402ApiKey) {
        return synthetic402(res, {
          key: freeNonce,
          used: true,
          scope: FREE_QUOTA_SCOPE,
        });
      }
      return next();
    }

    let onChainUsed = false;
    try {
      onChainUsed = await readNonceUsed(cfg.payGuardAddress, freeNonce);
    } catch {
      if (!cfg.enableX402 || !cfg.x402ApiKey) {
        return synthetic402(res, {
          key: freeNonce,
          used: true,
          scope: FREE_QUOTA_SCOPE,
        });
      }
      return next();
    }

    if (onChainUsed) {
      dailyQuota.consumeFreeSlot(nullifier);
      if (!cfg.enableX402 || !cfg.x402ApiKey) {
        return synthetic402(res, {
          key: freeNonce,
          used: true,
          scope: FREE_QUOTA_SCOPE,
        });
      }
      return next();
    }

    dailyQuota.consumeFreeSlot(nullifier);
    stats.record(agent.address, "free");
    (req as express.Request & { vetgateTier?: "free" | "paid" }).vetgateTier = "free";
    const payload = await buildPermitResponse(cfg, query, "free", freeNonce);
    return res.status(payload.status).json(payload.body);
  });

  if (cfg.enableX402 && cfg.x402ApiKey) {
    const facilitator = new HTTPFacilitatorClient({
      url: cfg.facilitatorUrl ?? celo.facilitatorUrl,
      createAuthHeaders: async () => {
        const h = { "X-API-Key": cfg.x402ApiKey! };
        return { verify: h, settle: h, supported: h };
      },
    });
    const x402Server = new x402ResourceServer(facilitator).register(
      celo.caip2,
      new ExactEvmScheme(),
    );
    app.use(paymentMiddleware(routes, x402Server, undefined, undefined, true)); // lazy init on first paid request: loads the facilitator's supported kinds
  }

  app.get("/v1/permit", async (req, res) => {
    const query = (req as express.Request & { vetgateQuery?: PermitQuery }).vetgateQuery;
    const tier = (req as express.Request & { vetgateTier?: "free" | "paid" }).vetgateTier ?? "paid";
    if (!query) {
      return res.status(400).json({ error: "invalid_query" });
    }
    if (tier === "free") {
      return res.status(200).end();
    }
    const payer =
      req.agent?.address ??
      (req as express.Request & { erc8004Agent?: Erc8004Agent }).erc8004Agent?.address;
    stats.record(payer!, "paid");
    const payload = await buildPermitResponse(cfg, query, "paid");
    return res.status(payload.status).json(payload.body);
  });

  return app;
}