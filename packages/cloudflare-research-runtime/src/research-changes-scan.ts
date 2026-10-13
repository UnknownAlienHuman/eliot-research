import { CatalogInputError } from "@eliotr/cloudflare-navigation";
import type { ResearchChangesVisibilityScan } from "@eliotr/interfaces";

// ER-45/#301: candidate SELECTs, independently of the number of visible items wanted.
export const RESEARCH_CHANGES_SCAN_BATCH = 100;
export const RESEARCH_CHANGES_SCAN_MAX_CANDIDATES = 600;
export const RESEARCH_CHANGES_SCAN_MAX_QUERIES = 6;

export interface ResearchChangesScanAnchor {
  readonly sequence: number;
  readonly change_ref: string;
}

export async function scanResearchChanges<Row extends ResearchChangesScanAnchor>(input: {
  readonly latest: boolean;
  readonly limit: number;
  readonly after: number;
  readonly forward_anchor: ResearchChangesScanAnchor | null;
  readonly visible_rows: Row[];
  readonly read_batch: (boundary: number, limit: number) => Promise<readonly Row[]>;
  readonly authorize_batch: (rows: readonly Row[]) => Promise<readonly Row[]>;
  readonly recheck_visible: () => Promise<boolean>;
}): Promise<{
  readonly rows: readonly Row[];
  readonly visibility_scan: ResearchChangesVisibilityScan;
  readonly has_more: boolean;
  readonly raw_anchor: ResearchChangesScanAnchor | null;
  readonly forward_anchor: ResearchChangesScanAnchor | null;
}> {
  const target = input.latest ? input.limit : input.limit + 1;
  let boundary = input.after;
  let queries = 0;
  let candidates = 0;
  let exhausted = false;
  let rawAnchor: ResearchChangesScanAnchor | null = null;
  let forwardAnchor = input.forward_anchor;
  const fetchUntilTarget = async (): Promise<void> => {
    while (!exhausted && input.visible_rows.length < target &&
        queries < RESEARCH_CHANGES_SCAN_MAX_QUERIES && candidates < RESEARCH_CHANGES_SCAN_MAX_CANDIDATES) {
      const capacity = Math.min(RESEARCH_CHANGES_SCAN_BATCH, RESEARCH_CHANGES_SCAN_MAX_CANDIDATES - candidates);
      const batch = await input.read_batch(boundary, capacity);
      queries += 1;
      if (batch.length > capacity) {
        throw new CatalogInputError("RESEARCH_CHANGES_READBACK_CORRUPT", "changes scan exceeds its raw capacity", 409);
      }
      let previous = boundary;
      for (const row of batch) {
        if (!Number.isSafeInteger(row.sequence) || row.sequence < 1 ||
            (input.latest ? row.sequence >= previous : row.sequence <= previous)) {
          throw new CatalogInputError("RESEARCH_CHANGES_READBACK_CORRUPT", "changes sequence ordering is invalid", 409);
        }
        previous = row.sequence;
      }
      candidates += batch.length;
      const first = batch.at(0);
      const last = batch.at(-1);
      if (input.latest && forwardAnchor === null && first !== undefined) {
        forwardAnchor = { sequence: first.sequence, change_ref: first.change_ref };
      }
      if (last !== undefined) {
        boundary = last.sequence;
        rawAnchor = { sequence: last.sequence, change_ref: last.change_ref };
        input.visible_rows.push(...await input.authorize_batch(batch));
      }
      exhausted = batch.length < capacity;
    }
  };
  await fetchUntilTarget();
  while (true) {
    const removed = await input.recheck_visible();
    if (!removed || input.visible_rows.length >= target || exhausted ||
        queries >= RESEARCH_CHANGES_SCAN_MAX_QUERIES || candidates >= RESEARCH_CHANGES_SCAN_MAX_CANDIDATES) break;
    await fetchUntilTarget();
  }
  const state = input.visible_rows.length >= target ? "TARGET_REACHED"
    : exhausted ? "SOURCE_EXHAUSTED" : "BUDGET_STOPPED";
  // Slice in traversal order first. Reversing a whole raw batch would select the oldest latest rows.
  const selected = input.visible_rows.slice(0, input.limit);
  return {
    rows: input.latest ? selected.reverse() : selected,
    visibility_scan: { direction: input.latest ? "LATEST" : "FORWARD", state },
    has_more: state === "BUDGET_STOPPED" || (!input.latest && input.visible_rows.length > input.limit),
    raw_anchor: rawAnchor,
    forward_anchor: forwardAnchor,
  };
}
