import { VET402_API_BASE } from "./chain.js";

export type Vet402CheckDocument = {
  recommendation?: string | null;
  delivery?: unknown;
  not_in_catalog?: boolean;
  [key: string]: unknown;
};

export async function fetchVet402Check(
  sellerUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Vet402CheckDocument> {
  const url = `${VET402_API_BASE}/api/v1/check?url=${encodeURIComponent(sellerUrl)}`;
  const resp = await fetchImpl(url);
  if (!resp.ok) {
    throw new Error(`vet402_check_failed:${resp.status}`);
  }
  return (await resp.json()) as Vet402CheckDocument;
}

export function isVet402Allow(doc: Vet402CheckDocument): boolean {
  return doc.recommendation === "ALLOW";
}