import { encodePacked, keccak256 } from "viem";

export const FREE_QUOTA_SCOPE =
  "per human per UTC day, shared across all agents of that human" as const;

/** UTC calendar day (YYYY-MM-DD) for shared daily free nonce scope. */
export function utcDayString(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Deterministic PayGuard nonce: same human + UTC day across all agents and instances. */
export function deriveFreePermitNonce(
  nullifier: string,
  utcDay = utcDayString(),
): `0x${string}` {
  return keccak256(
    encodePacked(
      ["string", "uint256", "string"],
      ["vetgate-free-v1", BigInt(nullifier), utcDay],
    ),
  );
}

/** Per-human (Self nullifier) UTC daily free permit quota, shared across all agents of that human. */
export class DailyHumanQuota {
  private usage = new Map<string, string>();

  private utcDay(): string {
    return utcDayString();
  }

  hasFreeSlot(nullifier: string): boolean {
    return this.usage.get(nullifier) !== this.utcDay();
  }

  consumeFreeSlot(nullifier: string): void {
    this.usage.set(nullifier, this.utcDay());
  }

  /** Test helper — how many humans consumed free quota today. */
  freeUsesToday(): number {
    const today = this.utcDay();
    let n = 0;
    for (const d of this.usage.values()) {
      if (d === today) n += 1;
    }
    return n;
  }
}