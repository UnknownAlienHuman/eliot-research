import type { TurnPage, TurnView } from '../shared/api';

export interface HistoryHead { tip: { createdAt: number; turnId: string } | undefined; ids: ReadonlySet<string> }

export function compareTurnOrder(a: Pick<TurnView, 'createdAt' | 'turnId'>, b: Pick<TurnView, 'createdAt' | 'turnId'>): number {
  return (a.createdAt ?? 0) - (b.createdAt ?? 0) || (a.turnId < b.turnId ? -1 : a.turnId > b.turnId ? 1 : 0);
}

export function advanceHistoryHead(previous: HistoryHead | null, page: TurnPage): { head: HistoryHead; rewind: boolean } | null {
  const tip = page.turns.at(-1);
  if (previous && (!tip || (previous.tip && compareTurnOrder(tip, previous.tip) <= 0))) return null;
  return { head: { tip: tip ? { turnId: tip.turnId, createdAt: tip.createdAt ?? 0 } : undefined,
    ids: new Set(page.turns.map((turn) => turn.turnId)) }, rewind: !previous || !page.turns.some((turn) => previous.ids.has(turn.turnId)) };
}

// Pages and reconnect snapshots can arrive after a newer streamed payload.
// Ordering is immutable; only the owning row's version decides replacement.
export function mergeTurnHistory(current: readonly TurnView[], incoming: readonly TurnView[]): TurnView[] {
  const turns = new Map(current.map((turn) => [turn.turnId, turn]));
  for (const turn of incoming) {
    const previous = turns.get(turn.turnId);
    if (!previous || (turn.historyVersion ?? 0) >= (previous.historyVersion ?? 0)) turns.set(turn.turnId, turn);
  }
  return [...turns.values()].sort(compareTurnOrder);
}
