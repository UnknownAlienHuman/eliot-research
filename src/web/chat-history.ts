import type { TurnView } from '../shared/api';

// Pages and reconnect snapshots can arrive after a newer streamed payload.
// Ordering is immutable; only the owning row's version decides replacement.
export function mergeTurnHistory(current: readonly TurnView[], incoming: readonly TurnView[]): TurnView[] {
  const turns = new Map(current.map((turn) => [turn.turnId, turn]));
  for (const turn of incoming) {
    const previous = turns.get(turn.turnId);
    if (!previous || (turn.historyVersion ?? 0) >= (previous.historyVersion ?? 0)) turns.set(turn.turnId, turn);
  }
  return [...turns.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)
    || (a.turnId < b.turnId ? -1 : a.turnId > b.turnId ? 1 : 0));
}
