import { fromDataSuffix, toDataSuffix } from "@celo/attribution-tags";
import { concat, type Hex } from "viem";

import { PLACEHOLDER_ATTRIBUTION_TAG, resolveAttributionCode } from "./chain.js";

export type AttributionTag = `0x${string}`;

/** ERC-8021 calldata suffix for the configured hackathon tag. */
export function attributionSuffix(code?: string): AttributionTag {
  return toDataSuffix(code ?? resolveAttributionCode());
}

/** Append the attribution suffix to contract call data (Altana execute, plain EOA calls). */
export function appendAttributionSuffix(data: Hex, code?: string): Hex {
  return concat([data, attributionSuffix(code)]);
}

/** True when `data` ends with a suffix that decodes to `expectedCode`. */
export function calldataIncludesAttribution(data: Hex, expectedCode?: string): boolean {
  const code = expectedCode ?? resolveAttributionCode();
  const suffix = attributionSuffix(code);
  if (!data.toLowerCase().endsWith(suffix.slice(2).toLowerCase())) {
    return false;
  }
  const decoded = fromDataSuffix(suffix);
  return decoded !== null && decoded.codes.includes(code);
}

export { PLACEHOLDER_ATTRIBUTION_TAG };