// U3-P presentation controller. Pure DTO-to-view helpers and local selection identity only.
// No remote store, cache, transport, factory instantiation, epoch or query client lives here.
// Server state is owned by the app's TanStack Query layer; this module only shapes what it returns.
import type { LibraryPage, LibraryReadinessView, ProjectSummary, SourceRevisionPage } from "@eliotr/owner-api-client";

export type ProjectsLibraryState = "loading" | "empty" | "degraded" | "error" | "useful";
export type ProjectsLibraryPanelState = "idle" | "loading" | "degraded" | "error" | "useful";

/** One library row. The readiness reference is shown verbatim and is never parsed. */
export interface SourceRow {
  readonly sourceId: string;
  readonly title: string;
  readonly readinessRef: string;
}

export interface ProjectRow {
  readonly projectId: string;
  readonly title: string;
  readonly revision: number;
}

/** A channel value as the panel presents it. Unmapped states stay `unknown` rather than becoming ready. */
export type ReadinessPresentation = "ready" | "partial" | "unavailable" | "unknown";

/** The three channels the readiness envelope carries, named exactly as the DTO names them. */
export type ReadinessChannelName = "exact_ready" | "lexical_ready" | "semantic_ready";

/** Channel states, named exactly as `ReadinessStateSchema` names them. */
export type ReadinessChannelState =
  | "not_requested"
  | "queued"
  | "running"
  | "ready"
  | "degraded"
  | "failed"
  | "stale"
  | "redacted";

const READINESS_CHANNELS: readonly ReadinessChannelName[] = ["exact_ready", "lexical_ready", "semantic_ready"];

export interface ReadinessRow {
  readonly sourceId: string;
  readonly sourceRevisionRef: string;
  readonly basis: "ACTIVE_VERIFIED";
  readonly qualityState: LibraryReadinessView["quality_state"];
  readonly exact: ReadinessPresentation;
  readonly lexical: ReadinessPresentation;
  readonly semantic: ReadinessPresentation;
  readonly currentnessVerified: boolean;
  readonly recordedFreshness: string | undefined;
  readonly verifiedFreshness: string | undefined;
  readonly reasonCodes: readonly string[];
}

export interface RevisionRow {
  readonly sourceRevisionRef: string;
  readonly contentSha256: string;
  readonly capturedAt: string;
  readonly admittedAt: string;
  readonly qualityState: SourceRevisionPage["revisions"][number]["quality_state"];
  readonly currentnessState: SourceRevisionPage["revisions"][number]["currentness_state"];
}

const QUALITY_LABEL = {
  high_fidelity: "high fidelity",
  standard: "standard",
  degraded: "degraded",
  unqualified: "unqualified",
} as const;

const FRESHNESS_LABEL: Readonly<Record<string, string>> = {
  current_confirmed: "current confirmed",
  observed_with_age: "observed with age",
  gap_detected: "gap detected",
  unknown: "unknown",
};

/** Presentation copy for a quality state, or undefined when the value is not in the accepted set. */
export function qualityLabel(state: LibraryReadinessView["quality_state"]): string | undefined {
  return QUALITY_LABEL[state];
}

/** Presentation copy for an observation freshness value, or undefined when unmapped. */
export function freshnessLabel(state: string): string | undefined {
  return FRESHNESS_LABEL[state];
}

/** The selected project row, or undefined when nothing is selected or the id is not on the page. */
export function selectProjectRow(
  projects: readonly ProjectSummary[],
  selectedProjectId: string | undefined,
): ProjectRow | undefined {
  if (selectedProjectId === undefined) return undefined;
  const found = projects.find(project => project.project_id === selectedProjectId);
  if (found === undefined) return undefined;
  return { projectId: found.project_id, title: found.title, revision: found.revision };
}

/**
 * The revision that belongs to the selected project, or undefined when there is no
 * selection. Readiness and revision scopes are never inferred from each other; this only
 * reports which project revision the panel is currently showing.
 */
export function selectedProjectRevision(
  projects: readonly ProjectSummary[],
  selectedProjectId: string | undefined,
): number | undefined {
  return selectProjectRow(projects, selectedProjectId)?.revision;
}

/** Library rows, in the decoded order. `readiness_ref` is carried verbatim, never parsed. */
export function toSourceRows(page: LibraryPage | undefined): readonly SourceRow[] {
  if (page === undefined) return [];
  return page.sources.map(source => ({
    sourceId: source.id,
    title: source.title,
    readinessRef: source.readiness_ref,
  }));
}

/**
 * Maps one DTO channel entry to presentation. The channel and state are compared as the DTO
 * names them, never as a concatenated string. A channel the envelope does not carry stays
 * `unknown`. A blocked state never softens into partial.
 */
export function channelPresentation(
  channels: readonly { readonly channel: string; readonly state: string }[],
  name: ReadinessChannelName,
): ReadinessPresentation {
  const found = channels.filter(entry => entry.channel === name);
  if (found.length === 0) return "unknown";
  if (found.some(entry => entry.state === "failed" || entry.state === "redacted")) return "unavailable";
  if (found.every(entry => entry.state === "ready")) return "ready";
  if (found.every(entry => ["ready", "degraded", "queued", "running"].includes(entry.state))) return "partial";
  return "unknown";
}

/** The three channel presentations, in the envelope's fixed channel order. */
export function toChannelPresentations(
  channels: readonly { readonly channel: string; readonly state: string }[],
): Readonly<Record<ReadinessChannelName, ReadinessPresentation>> {
  const out: Record<ReadinessChannelName, ReadinessPresentation> = {
    exact_ready: "unknown",
    lexical_ready: "unknown",
    semantic_ready: "unknown",
  };
  for (const name of READINESS_CHANNELS) out[name] = channelPresentation(channels, name);
  return out;
}

/**
 * Readiness presentation. The three channels are read from the DTO by name; a channel that
 * the DTO does not carry stays `unknown` instead of being treated as not requested or ready.
 */
export function toReadinessRow(readiness: LibraryReadinessView | undefined): ReadinessRow | undefined {
  if (readiness === undefined) return undefined;
  const currentness = readiness.currentness;
  const verified = currentness.verification === "VERIFIED";
  const presentations = toChannelPresentations(readiness.channels);
  return {
    sourceId: readiness.source_id,
    sourceRevisionRef: readiness.source_revision_ref,
    basis: readiness.readiness_basis,
    qualityState: readiness.quality_state,
    exact: presentations.exact_ready,
    lexical: presentations.lexical_ready,
    semantic: presentations.semantic_ready,
    currentnessVerified: verified,
    recordedFreshness: verified ? undefined : currentness.recorded_freshness,
    verifiedFreshness: verified ? currentness.value.observation_freshness : undefined,
    reasonCodes: verified ? [] : currentness.reason_codes,
  };
}

/** Revision rows in the decoded order. Ordering is inherited, never re-sorted here. */
export function toRevisionRows(page: SourceRevisionPage | undefined): readonly RevisionRow[] {
  if (page === undefined) return [];
  return page.revisions.map(revision => ({
    sourceRevisionRef: revision.source_revision_ref,
    contentSha256: revision.content_sha256,
    capturedAt: revision.captured_at,
    admittedAt: revision.admitted_at,
    qualityState: revision.quality_state,
    currentnessState: revision.currentness_state,
  }));
}

/**
 * Panel tone. A blocked quality state or an unavailable channel is never presented as usable
 * for evidence; unverified currentness stays `degraded` rather than becoming neutral.
 */
export function readinessTone(row: ReadinessRow | undefined): "useful" | "degraded" {
  if (row === undefined) return "degraded";
  if (row.qualityState === "unqualified") return "degraded";
  if (row.exact === "unavailable" || row.lexical === "unavailable" || row.semantic === "unavailable") {
    return "degraded";
  }
  if (!row.currentnessVerified) return "degraded";
  return "useful";
}

/** Whether a source row offers the revisions affordance. Selection identity only, no fetch. */
export function isRowSelected(row: SourceRow, selectedSourceId: string | undefined): boolean {
  return selectedSourceId !== undefined && row.sourceId === selectedSourceId;
}
