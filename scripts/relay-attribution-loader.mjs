import { toDataSuffix } from "@celo/attribution-tags";

const attributionCode = process.env.CELO_ATTRIBUTION_TAG ?? "celo_56284feb7672";
const suffixLiteral = toDataSuffix(attributionCode);

const RELAY_BUILD_RE =
  /return createClient\(\{\s*chain: network\.chain,\s*transport: sanitizingHttp\(network\.relayUrl\),\s*\}\);/;

export async function load(url, context, nextLoad) {
  if (!url.includes("/@altananetwork/sdk/dist/internal/relay.js")) {
    return nextLoad(url, context);
  }

  const loaded = await nextLoad(url, context);
  let source = loaded.source;
  if (source instanceof Uint8Array) {
    source = Buffer.from(source).toString("utf8");
  }
  if (typeof source !== "string" || !RELAY_BUILD_RE.test(source)) {
    return loaded;
  }

  source = source.replace(
    RELAY_BUILD_RE,
    `return createClient({
        chain: network.chain,
        transport: sanitizingHttp(network.relayUrl),
        dataSuffix: ${JSON.stringify(suffixLiteral)},
    });`,
  );

  return { ...loaded, source, format: "module" };
}