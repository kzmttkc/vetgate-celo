/**
 * Altana relay intents (grantSession, execute, revokeSession) get ERC-8021 via viem `dataSuffix`
 * when `scripts/register-relay-attribution.mjs` is loaded with `node --import` before the SDK.
 * Execute call `data` is suffixed when missing so PayGuard paths stay tagged twice-safe.
 */
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import { createClient, type Client, type CreateClientOptions } from "@altananetwork/sdk";
import type { Address, Hex } from "viem";

import { appendAttributionSuffix, attributionSuffix, calldataIncludesAttribution } from "./attribution.js";
import { resolveAttributionCode } from "./chain.js";

let relayPatched = false;
let loaderRegistered = false;

export function isRelayAttributionPatched(): boolean {
  return relayPatched;
}

/** @internal tests only */
export function setRelayAttributionPatchedForTests(value: boolean): void {
  relayPatched = value;
}

export function assertRelayAttributionPatched(): void {
  if (!relayPatched) {
    throw new Error(
      "refused: Altana relay client is missing ERC-8021 dataSuffix (start with node --import ./scripts/register-relay-attribution.mjs)",
    );
  }
}

function registerLoaderOnce(): void {
  if (loaderRegistered) return;
  const loader = fileURLToPath(new URL("../scripts/relay-attribution-loader.mjs", import.meta.url));
  register(loader, import.meta.url);
  loaderRegistered = true;
}

/** Register the relay source transform (must run before @altananetwork/sdk loads internal/relay.js). */
export async function ensureRelayAttributionSuffix(): Promise<void> {
  if (relayPatched) return;
  registerLoaderOnce();
  relayPatched = true;
}

export async function resetRelayAttributionPatchForTests(): Promise<void> {
  relayPatched = false;
}

export function createAttributedClient(opts: CreateClientOptions): Client {
  assertRelayAttributionPatched();
  return createClient(opts);
}

export async function createAttributedClientAsync(opts: CreateClientOptions): Promise<Client> {
  await ensureRelayAttributionSuffix();
  return createAttributedClient(opts);
}

type CallLike = { to: Address; value?: bigint; data?: Hex };

export function tagRelayCalls<T extends CallLike>(calls: readonly T[], code?: string): T[] {
  const expected = code ?? resolveAttributionCode();
  return calls.map((call) => {
    const data = call.data;
    if (data && calldataIncludesAttribution(data, expected)) {
      return call;
    }
    if (!data || data === "0x") {
      return { ...call, data: attributionSuffix(expected) };
    }
    return { ...call, data: appendAttributionSuffix(data, expected) };
  });
}

type ExecuteInput = {
  wallet?: { address: Address };
  signer?: unknown;
  session?: unknown;
  calls: CallLike | readonly CallLike[];
  chainId?: number;
  feeToken?: Address | readonly Address[];
  noWait?: boolean;
};

function tagExecuteInput<T extends ExecuteInput>(opts: T): T {
  const list = Array.isArray(opts.calls) ? opts.calls : [opts.calls];
  return { ...opts, calls: tagRelayCalls(list) as T["calls"] };
}

export async function attributedExecute(client: Client, opts: ExecuteInput) {
  assertRelayAttributionPatched();
  return client.execute(tagExecuteInput(opts) as Parameters<Client["execute"]>[0]);
}

export async function attributedQuoteExecute(client: Client, opts: ExecuteInput) {
  assertRelayAttributionPatched();
  return client.quoteExecute(tagExecuteInput(opts) as Parameters<Client["quoteExecute"]>[0]);
}

export async function attributedGrantSession(
  client: Client,
  opts: Parameters<Client["grantSession"]>[0],
) {
  assertRelayAttributionPatched();
  return client.grantSession(opts);
}

export async function attributedRevokeSession(
  client: Client,
  opts: Parameters<Client["revokeSession"]>[0],
) {
  assertRelayAttributionPatched();
  return client.revokeSession(opts);
}

export async function attributedQuoteGrantSession(
  client: Client,
  opts: Parameters<Client["quoteGrantSession"]>[0],
) {
  assertRelayAttributionPatched();
  return client.quoteGrantSession(opts);
}

export async function attributedQuoteRevokeSession(
  client: Client,
  opts: Parameters<Client["quoteRevokeSession"]>[0],
) {
  assertRelayAttributionPatched();
  return client.quoteRevokeSession(opts);
}