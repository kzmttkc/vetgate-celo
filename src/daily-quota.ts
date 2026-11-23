/** Per-human (Self nullifier) UTC daily free permit quota, shared across all agents of that human. */
export class DailyHumanQuota {
  private usage = new Map<string, string>();

  private utcDay(): string {
    return new Date().toISOString().slice(0, 10);
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