import express, { type Express, type RequestHandler } from "express";
import { privateKeyToAccount } from "viem/accounts";
import { SelfAgentVerifier } from "@selfxyz/agent-sdk";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient, type RoutesConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

import { resolveCeloRuntime } from "./chain.js";
import { DailyHumanQuota } from "./daily-quota.js";
import { mintVetGatePermit } from "./permit.js";
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
  dailyQuota?: DailyHumanQuota;
  stats?: StatsStore;
  vet402Fetch?: typeof fetch;
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
        reason: "vet402 recommendation is not ALLOW; VetGate will not mint an onchain payment permit.",
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
  });

  return {
    status: 200 as const,
    body: {
      tier,
      verdict: "ALLOW" as const,
      vet402,
      permit,
    },
  };
}

export function createApp(cfg: CreateAppConfig): Express {
  const celo = resolveCeloRuntime();
  const teamWallets = parseTeamWallets(cfg.teamWalletsCsv);
  const dailyQuota = cfg.dailyQuota ?? new DailyHumanQuota();
  const stats = cfg.stats ?? new StatsStore(teamWallets);

  const selfAuth =
    cfg.selfAuth ??
    SelfAgentVerifier.create()
      .network(celo.selfNetwork)
      .sybilLimit(0)
      .requireAge(18)
      .requireOFAC()
      .build()
      .auth();

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

  app.get("/v1/stats", (_req, res) => {
    res.json({ network: celo.caip2, stats: stats.snapshot() });
  });

  app.use("/v1", (req, res, next) => {
    if (req.path === "/stats") return next();
    return selfAuth(req, res, (err: unknown) => {
      if (err) {
        return res.status(403).json({
          error: "self_verification_failed",
          message: `Self Agent ID verification failed. Register on Celo ${celo.selfNetwork} before calling VetGate.`,
        });
      }
      if (!req.agent) {
        return res.status(401).json({
          error: "self_agent_required",
          message: "Missing or invalid Self Agent ID request signature (x-self-agent-signature, x-self-agent-timestamp).",
        });
      }
      return next();
    });
  });

  const synthetic402 = (res: express.Response) =>
    res.status(402).json({
      error: "x402_payment_required",
      message:
        `Daily free human quota exhausted. Pay $0.01 USDC on Celo ${celo.network} via x402 to continue.`,
      x402: routes["GET /v1/permit"],
      network: celo.caip2,
    });

  app.get("/v1/permit", async (req, res, next) => {
    const query = parsePermitQuery(req);
    if (!query) {
      return res.status(400).json({
        error: "invalid_query",
        message: "Required query params: payTo, buyer, sellerUrl (https URL).",
      });
    }

    const agent = req.agent!;
    const nullifier = agent.nullifier.toString();
    (req as express.Request & { vetgateQuery?: PermitQuery }).vetgateQuery = query;
    (req as express.Request & { vetgateTier?: "free" | "paid" }).vetgateTier = "paid";

    if (dailyQuota.hasFreeSlot(nullifier)) {
      dailyQuota.consumeFreeSlot(nullifier);
      stats.record(agent.address, "free");
      (req as express.Request & { vetgateTier?: "free" | "paid" }).vetgateTier = "free";
      const payload = await buildPermitResponse(cfg, query, "free");
      return res.status(payload.status).json(payload.body);
    }

    if (!cfg.enableX402 || !cfg.x402ApiKey) {
      return synthetic402(res);
    }

    return next();
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
    app.use(paymentMiddleware(routes, x402Server, undefined, undefined, false));
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
    stats.record(req.agent!.address, "paid");
    const payload = await buildPermitResponse(cfg, query, "paid");
    return res.status(payload.status).json(payload.body);
  });

  return app;
}