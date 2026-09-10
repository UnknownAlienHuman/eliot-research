export interface IdGenerator {
  next(prefix: string): string;
}

export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;
  public next(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${String(this.counter).padStart(6, "0")}`;
  }
}
