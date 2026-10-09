// U3-P controller stories. Real DTO fixtures against the pure helpers. Offline, no query client.
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import {
  channelPresentation,
  qualityLabel,
  readinessTone,
  selectProjectRow,
  selectedProjectRevision,
  toChannelPresentations,
  toReadinessRow,
  toRevisionRows,
  toSourceRows,
} from "../../../features/sources/projects/controller";
import type { LibraryPage, LibraryReadinessView, ProjectSummary, SourceRevisionPage } from "@eliotr/owner-api-client";
import { ProjectsLibraryFeature } from "../../../features/sources/projects/ProjectsLibraryFeature";

const REVISION_REF = "rev-0001-abcd";
const SOURCE_ID = "src-0001-efgh";

const projects: readonly ProjectSummary[] = [
  { project_id: "proj-0001", title: "Everyday research", revision: 3, source_ids: [SOURCE_ID], created_at: "2026-10-09T00:00:00.000Z" },
  { project_id: "proj-0002", title: "Second project", revision: 1, source_ids: [], created_at: "2026-10-01T00:00:00.000Z" },
];

const page: LibraryPage = {
  projects: [{ id: "proj-0001", title: "Everyday research", generation: "gen-1" }],
  sources: [{ id: SOURCE_ID, title: "Notes on evidence and clear thinking", readiness_ref: `readiness:${SOURCE_ID}:${REVISION_REF}` }],
  generation: "gen-1",
  trace: "trace-1",
};

function channel(channelName: LibraryReadinessView["channels"][number]["channel"], state: LibraryReadinessView["channels"][number]["state"]): LibraryReadinessView["channels"][number] {
  return { source_revision_ref: REVISION_REF, channel: channelName, state: state, reason_codes: [], observed_at: "2026-10-09T00:00:00.000Z" };
}

const baseReadiness: Omit<LibraryReadinessView, "channels"> = {
  protocol: "eliotr.library-readiness.v1",
  source_id: SOURCE_ID,
  source_revision_ref: REVISION_REF,
  deployment_generation: "gen-1",
  catalog_generation: "1",
  observed_at: "2026-10-09T00:00:00.000Z",
  quality_state: "high_fidelity",
  readiness_basis: "ACTIVE_VERIFIED",
  currentness: { verification: "VERIFIED", value: { source_revision_ref: REVISION_REF, owner_system_id: "own-1", source_owner_generation: "sg-1", source_view_ref: "view-1", observation_freshness: "current_confirmed", observed_at: "2026-10-09T00:00:00.000Z", gap_refs: [] } },
};

const readyReadiness: LibraryReadinessView = {
  ...baseReadiness,
  channels: [channel("exact_ready", "ready"), channel("lexical_ready", "ready"), channel("semantic_ready", "ready")],
};

const blockedReadiness: LibraryReadinessView = {
  ...baseReadiness,
  channels: [channel("exact_ready", "ready"), channel("lexical_ready", "failed"), channel("semantic_ready", "ready")],
};

const unverifiedReadiness: LibraryReadinessView = {
  ...baseReadiness,
  channels: [channel("exact_ready", "ready"), channel("lexical_ready", "queued"), channel("semantic_ready", "ready")],
  currentness: { verification: "NOT_VERIFIED", recorded_freshness: "observed_with_age", reason_codes: ["NOT_REVERIFIED"] },
};

const revisions: SourceRevisionPage = {
  source_id: SOURCE_ID,
  head_revision_ref: REVISION_REF,
  observed_at: "2026-10-09T00:00:00.000Z",
  readiness_basis: "RECORDED_ONLY",
  revisions: [
    { source_revision_ref: "rev-0002-bbbb", content_sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", captured_at: "2026-10-08T00:00:00.000Z", admitted_at: "2026-10-08T01:00:00.000Z", quality_state: "standard", currentness_state: "current_confirmed", readiness: [] },
    { source_revision_ref: "rev-0001-aaaa", content_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", captured_at: "2026-10-07T00:00:00.000Z", admitted_at: "2026-10-07T01:00:00.000Z", quality_state: "high_fidelity", currentness_state: "observed_with_age", readiness: [] },
  ],
  generation: "gen-1",
  trace: "trace-1",
};

const meta = {
  title: "Product/Sources/ProjectsLibraryController",
  component: ProjectsLibraryFeature,
  args: {
    locale: "en", state: "useful", projects, selectedProjectId: "proj-0001", library: page,
    readiness: readyReadiness, readinessState: "useful", revisions, revisionsState: "useful",
    selectedSourceId: SOURCE_ID, onSelectProject() {}, onOpenSource() {}, onLoadRevisions() {}, onRetry() {},
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ProjectsLibraryFeature>;
export default meta;

export const ChannelMapping: StoryObj = {
  play: async () => {
    expect(channelPresentation(readyReadiness.channels, "exact_ready")).toBe("ready");
    expect(channelPresentation(blockedReadiness.channels, "lexical_ready")).toBe("unavailable");
    expect(channelPresentation(blockedReadiness.channels, "exact_ready")).toBe("ready");
    expect(channelPresentation(unverifiedReadiness.channels, "lexical_ready")).toBe("partial");
    expect(channelPresentation([], "semantic_ready")).toBe("unknown");
    expect(channelPresentation([channel("semantic_ready", "stale")], "semantic_ready")).toBe("unknown");
    expect(channelPresentation([{channel:"semantic_ready",state:"invented"}], "semantic_ready")).toBe("unknown");
    expect(qualityLabel("high_fidelity")).toBe("high fidelity");
    expect(qualityLabel("unqualified")).toBe("unqualified");
  },
};

export const PresentationsAndTone: StoryObj = {
  play: async () => {
    const ready = toReadinessRow(readyReadiness);
    const blocked = toReadinessRow(blockedReadiness);
    const unverified = toReadinessRow(unverifiedReadiness);
    expect(ready?.exact).toBe("ready");
    expect(ready?.lexical).toBe("ready");
    expect(ready?.semantic).toBe("ready");
    expect(ready?.currentnessVerified).toBe(true);
    expect(readinessTone(ready)).toBe("useful");
    expect(blocked?.lexical).toBe("unavailable");
    expect(readinessTone(blocked)).toBe("degraded");
    expect(unverified?.lexical).toBe("partial");
    expect(unverified?.currentnessVerified).toBe(false);
    expect(unverified?.recordedFreshness).toBe("observed_with_age");
    expect(unverified?.verifiedFreshness).toBeUndefined();
    expect(readinessTone(unverified)).toBe("degraded");
    expect(readinessTone(undefined)).toBe("degraded");
    const all = toChannelPresentations(blockedReadiness.channels);
    expect(all.exact_ready).toBe("ready");
    expect(all.lexical_ready).toBe("unavailable");
    expect(all.semantic_ready).toBe("ready");
  },
};

export const SelectionAndRows: StoryObj = {
  play: async () => {
    expect(selectProjectRow(projects, "proj-0001")?.title).toBe("Everyday research");
    expect(selectProjectRow(projects, "proj-0002")?.revision).toBe(1);
    expect(selectProjectRow(projects, undefined)).toBeUndefined();
    expect(selectProjectRow(projects, "missing")).toBeUndefined();
    expect(selectedProjectRevision(projects, "proj-0001")).toBe(3);
    expect(selectedProjectRevision(projects, undefined)).toBeUndefined();
    const rows = toSourceRows(page);
    expect(rows.length).toBe(1);
    expect(rows[0]?.sourceId).toBe(SOURCE_ID);
    expect(rows[0]?.readinessRef).toBe(`readiness:${SOURCE_ID}:${REVISION_REF}`);
    expect(toSourceRows(undefined).length).toBe(0);
    const revs = toRevisionRows(revisions);
    expect(revs.length).toBe(2);
    const first = revs[0], second = revs[1];
    if (!first || !second) throw new Error("Fixture revisions missing");
    expect(first.admittedAt > second.admittedAt).toBe(true);
    expect(second.qualityState).toBe("high_fidelity");
    expect(second.currentnessState).toBe("observed_with_age");
    expect(toRevisionRows(undefined).length).toBe(0);
  },
};
