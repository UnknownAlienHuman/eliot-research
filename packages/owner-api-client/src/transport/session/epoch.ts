/** Pure session-epoch mint for the owner client. No DOM, events, strings or timers. */

export interface SessionEpoch {
  capture(): object | undefined;
  isCurrent(capture: unknown): boolean;
  advance(): object;
  close(): void;
  dispose(): void;
}

export function createSessionEpoch(): SessionEpoch {
  let disposed = false;
  let stamp: object | undefined = Object.freeze({});

  return {
    capture() {
      return stamp;
    },
    isCurrent(capture: unknown) {
      return !disposed && stamp !== undefined && capture === stamp;
    },
    advance() {
      if (disposed) throw new TypeError("cannot advance a disposed epoch");
      stamp = Object.freeze({});
      return stamp;
    },
    close() {
      stamp = undefined;
    },
    dispose() {
      disposed = true;
      stamp = undefined;
    },
  };
}
