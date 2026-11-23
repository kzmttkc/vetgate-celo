export type CallKind = "free" | "paid";

export type StatsSnapshot = {
  team: { free: number; paid: number };
  independent: { free: number; paid: number };
  total: { free: number; paid: number };
};

export class StatsStore {
  private teamFree = 0;
  private teamPaid = 0;
  private independentFree = 0;
  private independentPaid = 0;

  constructor(private readonly teamWallets: ReadonlySet<string>) {}

  record(callerWallet: string, kind: CallKind): void {
    const team = this.teamWallets.has(callerWallet.toLowerCase());
    if (team) {
      if (kind === "free") this.teamFree += 1;
      else this.teamPaid += 1;
    } else {
      if (kind === "free") this.independentFree += 1;
      else this.independentPaid += 1;
    }
  }

  snapshot(): StatsSnapshot {
    return {
      team: { free: this.teamFree, paid: this.teamPaid },
      independent: { free: this.independentFree, paid: this.independentPaid },
      total: {
        free: this.teamFree + this.independentFree,
        paid: this.teamPaid + this.independentPaid,
      },
    };
  }
}

export function parseTeamWallets(csv: string | undefined): Set<string> {
  const set = new Set<string>();
  for (const part of (csv ?? "").split(",")) {
    const w = part.trim().toLowerCase();
    if (w.startsWith("0x") && w.length === 42) set.add(w);
  }
  return set;
}