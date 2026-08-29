export interface Clock {
  now(): Date;
  nowIso(): string;
  nowEpochMs(): number;
}

export class FakeClock implements Clock {
  public constructor(private current: Date) {}
  public now(): Date { return new Date(this.current); }
  public nowIso(): string { return this.current.toISOString(); }
  public nowEpochMs(): number { return this.current.getTime(); }
  public advanceMs(ms: number): void { this.current = new Date(this.current.getTime() + ms); }
}
