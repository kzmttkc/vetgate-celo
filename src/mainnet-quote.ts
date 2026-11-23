import { formatQuoteLine } from "@altananetwork/sdk";

/** Print relay quote status and per-leg costs for `--dry` mainnet steps. */
export function printRelayQuote(label: string, quote: unknown): void {
  const q = quote as {
    status?: string;
    complete?: boolean;
    lines?: Array<Parameters<typeof formatQuoteLine>[0]>;
    legs?: unknown[];
    maxFee?: bigint;
    fee?: bigint;
    feeToken?: string;
    feeTokenDeficit?: string | number | bigint;
    reason?: string;
    deferred?: boolean;
  };

  const deficit = q.feeTokenDeficit;
  const feeQuoted =
    q.fee !== undefined &&
    (deficit === undefined || deficit === "0" || deficit === 0 || deficit === 0n);
  const status =
    q.complete === true || feeQuoted
      ? "complete"
      : q.status ??
        (q.complete === false ? "incomplete" : "quoted");

  const parts: string[] = [`status=${status}`];

  if (q.fee !== undefined) parts.push(`fee=${q.fee.toString()}`);
  if (q.maxFee !== undefined) parts.push(`maxFee=${q.maxFee.toString()}`);
  if (q.feeToken) parts.push(`feeToken=${q.feeToken}`);
  if (q.reason) parts.push(`reason=${q.reason}`);

  const quoteLines = Array.isArray(q.lines) && q.lines.length > 0 ? q.lines : undefined;
  const singleLine =
    quoteLines ??
    ("kind" in q && "payer" in q
      ? [q as Parameters<typeof formatQuoteLine>[0]]
      : undefined);

  if (singleLine && singleLine.length > 0) {
    for (const line of singleLine) {
      try {
        parts.push(formatQuoteLine(line));
      } catch {
        parts.push(JSON.stringify(line, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
      }
    }
  } else if (parts.length <= 3) {
    parts.push(
      JSON.stringify(quote, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
    );
  }

  console.log(`[dry] ${label}: ${parts.join(" | ")}`);
}