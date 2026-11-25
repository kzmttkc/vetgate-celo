import { describe, expect, it, beforeEach } from "vitest";
import { CELO, createClient, signerFromPrivateKey } from "@altananetwork/sdk";

import {
  attributedRevokeSession,
  ensureRelayAttributionSuffix,
  isRelayAttributionPatched,
  setRelayAttributionPatchedForTests,
  tagRelayCalls,
} from "../src/attributed-altana-client.js";
import { attributionSuffix } from "../src/attribution.js";
import { PLACEHOLDER_ATTRIBUTION_TAG } from "../src/chain.js";
import { loadRelayModuleForTests } from "./relay-module-test-only.js";

describe("attributed Altana relay client", () => {
  beforeEach(async () => {
    await ensureRelayAttributionSuffix();
  });

  it("patches relay buildRelayClient with viem dataSuffix", () => {
    expect(isRelayAttributionPatched()).toBe(true);
    const relayMod = loadRelayModuleForTests();
    const relayClient = relayMod.buildRelayClient(CELO);
    expect(relayClient.dataSuffix).toEqual(attributionSuffix(PLACEHOLDER_ATTRIBUTION_TAG));
  });

  it("tags execute calls that lack suffix", () => {
    const tagged = tagRelayCalls([
      { to: "0x00000000000000000000000000000000000000aa", data: "0xdeadbeef" },
    ]);
    expect(tagged[0]?.data?.toLowerCase()).toContain(
      attributionSuffix(PLACEHOLDER_ATTRIBUTION_TAG).slice(2).toLowerCase(),
    );
  });

  it("refuses revokeSession when relay attribution patch flag is off", async () => {
    setRelayAttributionPatchedForTests(false);
    const client = createClient({ chains: [CELO], agentIdentity: false });
    const wallet = { address: "0xCDb0FF6e6Dfc33F9d75288772c8EfFaa13df9941" as const };

    await expect(
      attributedRevokeSession(client, {
        wallet,
        signer: signerFromPrivateKey(("0x" + "ab".repeat(32)) as `0x${string}`),
        session: ("0x" + "22".repeat(32)) as `0x${string}`,
        chainId: CELO.chainId,
      }),
    ).rejects.toThrow(/dataSuffix/i);

    await ensureRelayAttributionSuffix();
  });
});