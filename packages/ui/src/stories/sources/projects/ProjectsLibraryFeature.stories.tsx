// U3-P Projects Library feature stories. Real DTO props, offline, no query client.
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { LibraryPage, LibraryReadinessView, SourceRevisionPage, ProjectListView } from "@eliotr/owner-api-client";
import { ProjectsLibraryFeature, type ProjectsLibraryFeatureProps } from "../../../features/sources/projects/ProjectsLibraryFeature";

// Native assertions/callback recording follow app previews; no test-addon runtime import.
const recordedActions = new WeakMap<(value: string) => void, string[]>();
function recordAction(): (value?: string) => void {
  const calls: string[] = [];
  const action = (value?: string) => { calls.push(value ?? "retry"); };
  recordedActions.set(action, calls);
  return action;
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new globalThis.Error(message);
}
function resetAction(action: ((value: string) => void) | undefined): string[] {
  const calls = action === undefined ? undefined : recordedActions.get(action);
  assert(calls !== undefined, "The journey callback must use its own native recorder.");
  calls.length = 0;
  return calls;
}
function requireButton(canvas: HTMLElement, name: string | RegExp): HTMLButtonElement {
  const button = Array.from(canvas.getElementsByTagName("button")).find(element => {
    const label = element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "";
    return typeof name === "string" ? label === name : name.test(label);
  });
  assert(button !== undefined, "Missing native button: " + String(name));
  return button;
}
function requireText(canvas: HTMLElement, text: string): HTMLElement {
  const element = Array.from(canvas.getElementsByTagName("*")).find(candidate => candidate.textContent?.trim() === text);
  assert(element instanceof HTMLElement, "Missing text: " + text);
  return element;
}

function assertNoFalseAbsence(canvas: HTMLElement): void {
  const text = canvas.textContent ?? "";
  assert(!text.includes("No projects are available yet."), "Unknown project data must not claim project absence.");
  assert(!text.includes("No sources in this project."), "Missing selection/page must not claim source absence.");
}
function requireStatus(canvas: HTMLElement, text: string): HTMLElement {
  // Visible quiet Status element: static text keeps its meaning without announcing.
  const element = Array.from(canvas.getElementsByTagName("*"))
    .find(candidate => candidate.getAttribute("role") !== "status" && candidate.textContent?.includes(text)
      && candidate.getElementsByTagName("*").length === 0 && candidate.tagName !== "OPTION");
  assert(element instanceof HTMLElement, "Missing visible status: " + text);
  return element;
}

/** No status, live region or alert may exist for this presentation-only reader. */
function requireNoAnnouncingElement(canvas: HTMLElement): void {
  const announcing = Array.from(canvas.querySelectorAll('[role="status"], [aria-live], [role="alert"]'));
  assert(announcing.length === 0, "Feature must not create per-status announcements: " + String(announcing.map(node => node.textContent?.trim())));
}

/** Readiness is panel zero and saved versions is panel one, so retries stay panel-scoped. */
function requirePanels(canvas: HTMLElement): { readonly readiness: HTMLElement; readonly versions: HTMLElement } {
  const panels = Array.from(canvas.querySelectorAll(".er-projects-library__panel"));
  assert(panels.length === 2, "Both readiness and versions panels must exist.");
  const readiness = panels[0];
  const versions = panels[1];
  assert(readiness instanceof HTMLElement && versions instanceof HTMLElement, "Each panel must be an element.");
  return { readiness, versions };
}

const SOURCE_ID = "src-0001-efgh";
const READINESS_REF = `readiness:${SOURCE_ID}:rev-0001-abcd`;

const projects: ProjectListView["projects"] = [
  { project_id: "proj-0001", title: "Everyday research", revision: 3, source_ids: [SOURCE_ID], created_at: "2026-10-09T00:00:00.000Z" },
  { project_id: "proj-0002", title: "Model comparison", revision: 1, source_ids: [], created_at: "2026-10-09T00:00:00.000Z" },
];

const library: LibraryPage = {
  projects: [{ id: "proj-0001", title: "Everyday research", generation: "gen-1" }],
  sources: [{ id: SOURCE_ID, title: "Notes on evidence and clear thinking", readiness_ref: READINESS_REF }],
  generation: "gen-1",
  trace: "trace-1",
};

function channel(name: LibraryReadinessView["channels"][number]["channel"], state: LibraryReadinessView["channels"][number]["state"], generation?: string, receiptRef?: string): LibraryReadinessView["channels"][number] {
  return { source_revision_ref: "rev-0001-abcd", channel: name, state: state, reason_codes: [], observed_at: "2026-10-09T00:00:00.000Z", ...(generation === undefined ? {} : { generation }), ...(receiptRef === undefined ? {} : { receipt_ref: receiptRef }) };
}

const readyReadiness: LibraryReadinessView = {
  protocol: "eliotr.library-readiness.v1",
  source_id: SOURCE_ID,
  source_revision_ref: "rev-0001-abcd",
  deployment_generation: "gen-1",
  catalog_generation: "1",
  observed_at: "2026-10-09T00:00:00.000Z",
  quality_state: "high_fidelity",
  readiness_basis: "ACTIVE_VERIFIED",
  currentness: { verification: "VERIFIED", value: { source_revision_ref: "rev-0001-abcd", owner_system_id: "own-1", source_owner_generation: "sg-1", source_view_ref: "view-1", observation_freshness: "current_confirmed", observed_at: "2026-10-09T00:00:00.000Z", gap_refs: [] } },
  channels: [channel("exact_ready", "ready", "gen-1", "rc-1"), channel("lexical_ready", "ready", "gen-1", "rc-2"), channel("semantic_ready", "ready", "gen-1", "rc-3")],
};

const partlyAvailableReadiness: LibraryReadinessView = {
  ...readyReadiness,
  channels: [channel("exact_ready", "ready", "gen-1", "rc-1"), channel("lexical_ready", "failed"), channel("semantic_ready", "ready", "gen-1", "rc-3")],
};

const semanticPendingReadiness: LibraryReadinessView = {
  ...readyReadiness,
  channels: [channel("exact_ready", "ready", "gen-1", "rc-1"), channel("lexical_ready", "ready", "gen-1", "rc-2"), channel("semantic_ready", "running")],
};

const unknownCurrentnessReadiness: LibraryReadinessView = {
  ...readyReadiness,
  currentness: { verification: "NOT_VERIFIED", recorded_freshness: "unknown", reason_codes: ["CURRENTNESS_UNAVAILABLE"] },
  channels: [channel("exact_ready", "ready", "gen-1", "rc-1"), channel("lexical_ready", "ready", "gen-1", "rc-2"), channel("semantic_ready", "not_requested")],
};

const allChannelsBlockedReadiness: LibraryReadinessView = {
  ...readyReadiness,
  channels: [channel("exact_ready", "failed"), channel("lexical_ready", "failed"), channel("semantic_ready", "failed")],
};

const revisions: SourceRevisionPage = {
  source_id: SOURCE_ID,
  head_revision_ref: "rev-0002-bbbb",
  observed_at: "2026-10-09T00:00:00.000Z",
  readiness_basis: "RECORDED_ONLY",
  revisions: [
    { source_revision_ref: "rev-0002-bbbb", content_sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", captured_at: "2026-10-08T00:00:00.000Z", admitted_at: "2026-10-08T01:00:00.000Z", quality_state: "standard", currentness_state: "current_confirmed", readiness: [] },
    { source_revision_ref: "rev-0001-aaaa", content_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", captured_at: "2026-10-07T00:00:00.000Z", admitted_at: "2026-10-07T01:00:00.000Z", quality_state: "high_fidelity", currentness_state: "observed_with_age", readiness: [] },
  ],
  next_cursor: "older-revisions-cursor",
  generation: "gen-1",
  trace: "trace-1",
};

const meta = {
  title: "Product/Sources/ProjectsLibrary",
  component: ProjectsLibraryFeature,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ProjectsLibraryFeature>;
export default meta;

function base(args: Partial<ProjectsLibraryFeatureProps>): ProjectsLibraryFeatureProps {
  return {
    locale: "en",
    state: "useful",
    projects,
    selectedProjectId: "proj-0001",
    onSelectProject: recordAction(),
    library,
    readiness: readyReadiness,
    readinessState: "useful",
    revisions,
    revisionsState: "useful",
    selectedSourceId: SOURCE_ID,
    onOpenSource: recordAction(),
    onLoadRevisions: recordAction(),
    onRetry: () => {},
    ...args,
  };
}

export const Populated: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({}),
};

const recordedRows: LibraryPage = { ...library, sources: ["ready", "queued", "failed", "stale", "unknown"].map((state, index) => {
  const id = SOURCE_ID + "-" + index, ref = "recorded-revision-" + index;
  return { id, title: "Source with " + state + " observations", readiness_ref: "readiness:" + id + ":" + ref,
    readiness_summary: { protocol: "eliotr.library-row-readiness.v1", source_revision_ref: ref, basis: "RECORDED_ONLY",
      scope: "SOURCE_PROJECTION", observed_at: "2026-10-17T12:00:00Z", quality_state: "standard",
      channels: state === "unknown" ? [] : (["exact_ready", "lexical_ready", "semantic_ready"] as const).map(name => ({
        source_revision_ref: ref, channel: name, state: state as "ready" | "queued" | "failed" | "stale",
        generation: "recorded-generation", receipt_ref: "recorded-receipt", reason_codes: [], observed_at: "2026-10-16T10:00:00Z",
      })) } };
}) };
export const RecordedRowReadiness: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({ library: recordedRows, selectedSourceId: undefined, readiness: undefined, readinessState: "idle",
    revisions: undefined, revisionsState: "idle" }),
  play: ({ canvasElement }) => {
    const rows = canvasElement.querySelectorAll(".er-projects-library__source");
    assert(rows.length === 5, "Every source needs its own summary.");
    for (const text of ["Ready at last check", "Indexing queued", "Needs attention", "Readiness unknown"]) {
      assert(canvasElement.textContent?.includes(text), "Missing recorded row label: " + text);
    }
    assert(canvasElement.querySelectorAll("time").length === 5, "Each observation needs a timestamp.");
    assert(canvasElement.querySelector('[data-state="stale"]') !== null, "Stale observation must stay distinct.");
    requireNoAnnouncingElement(canvasElement);
  },
};
export const RecordedRowReadinessRussian: StoryObj<typeof ProjectsLibraryFeature> = {
  args: { ...RecordedRowReadiness.args, locale: "ru" },
  play: ({ canvasElement }) => {
    for (const text of ["Готов при последней проверке", "В очереди на индексацию", "Требует внимания", "Готовность неизвестна"]) {
      assert(canvasElement.textContent?.includes(text), "Missing Russian recorded row label: " + text);
    }
    assert(canvasElement.querySelectorAll("time").length === 5, "Russian row timestamps must remain visible.");
    requireNoAnnouncingElement(canvasElement);
  },
};

export const Loading: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({ state: "loading", projects: [], selectedProjectId: undefined, library: undefined,
    readiness: undefined, readinessState: "idle", revisions: undefined, revisionsState: "idle", selectedSourceId: undefined }),
  play: ({ canvasElement, args }) => {
    const selected = resetAction(args.onSelectProject);
    assert(requireStatus(canvasElement, "Loading project sources...").getClientRects().length > 0, "Loading must remain visible.");
    assertNoFalseAbsence(canvasElement);
    assert(selected.length === 0, "Loading must not select a project while rendering.");
  },
};

export const UnselectedProject: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({ selectedProjectId: undefined, library: undefined, readiness: undefined, readinessState: "idle",
    revisions: undefined, revisionsState: "idle", selectedSourceId: undefined }),
  play: ({ canvasElement, args }) => {
    const selected = resetAction(args.onSelectProject);
    assert(requireStatus(canvasElement, "Choose a project").getClientRects().length > 0, "Unselected context must explain project choice.");
    assertNoFalseAbsence(canvasElement);
    assert(selected.length === 0, "Unselected context must not select a project while rendering.");
  },
};

export const Empty: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({ library: { ...library, sources: [] } }),
};

export const Degraded: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({ state: "degraded", readiness: undefined, readinessState: "degraded" }),
};

export const Error: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({ state: "error", projects: [], selectedProjectId: undefined, library: undefined,
    readiness: undefined, readinessState: "idle", revisions: undefined, revisionsState: "idle", selectedSourceId: undefined }),
  play: ({ canvasElement }) => {
    assert(requireStatus(canvasElement, "Sources could not be loaded.").getClientRects().length > 0, "Error must remain visible.");
    assertNoFalseAbsence(canvasElement);
    assert(requireButton(canvasElement, "Try again").isConnected, "The existing retry action must remain available.");
  },
};

function requireReadinessChannelStates(
  canvas: HTMLElement,
  expected: readonly ("ready" | "partial" | "unavailable" | "unknown")[],
): void {
  const disclosure = canvas.querySelector(".er-projects-library__channels > summary");
  assert(disclosure instanceof HTMLElement, "Missing native search-channel disclosure.");
  disclosure.click();
  const details = disclosure.parentElement;
  assert(details instanceof HTMLDetailsElement && details.open, "Search-channel facts must remain available in native details.");
  const actual = Array.from(details.querySelectorAll("dd"), item => item.getAttribute("data-state"));
  assert(actual.length === expected.length && expected.every((state, index) => actual[index] === state),
    `Search channel facts must remain exact: ${String(actual)}`);
}

export const ReadinessPartlyAvailable: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({ readiness: partlyAvailableReadiness }),
  play: ({ canvasElement }) => {
    const summary = requireText(canvasElement, "Search partly available");
    assert(summary.closest(".er-projects-library__summary")?.getAttribute("data-state") === "partial",
      "A failed channel alongside ready channels must not appear fully ready or fully blocked.");
    requireReadinessChannelStates(canvasElement, ["ready", "unavailable", "ready"]);
  },
};

export const ReadinessSemanticPending: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({ readiness: semanticPendingReadiness }),
  play: ({ canvasElement }) => {
    const summary = requireText(canvasElement, "Still being indexed");
    assert(summary.closest(".er-projects-library__summary")?.getAttribute("data-state") === "working",
      "A running semantic channel must remain in progress while faster channels are ready.");
    requireReadinessChannelStates(canvasElement, ["ready", "ready", "partial"]);
  },
};

export const ReadinessUnknownCurrentness: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({ readiness: unknownCurrentnessReadiness }),
  play: ({ canvasElement }) => {
    const summary = requireText(canvasElement, "Unknown");
    assert(summary.closest(".er-projects-library__summary")?.getAttribute("data-state") === "unknown",
      "Unverified currentness and a not-requested channel must stay neutral.");
    assert(requireText(canvasElement, "Currentness was not verified.").getClientRects().length > 0,
      "The existing currentness warning must remain visible.");
    requireReadinessChannelStates(canvasElement, ["ready", "ready", "unknown"]);
  },
};

export const ReadinessBlocked: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({ readiness: allChannelsBlockedReadiness }),
  play: ({ canvasElement }) => {
    const summary = requireText(canvasElement, "Not searchable yet");
    assert(summary.closest(".er-projects-library__summary")?.getAttribute("data-state") === "blocked",
      "Only three unavailable channels may produce the not-searchable summary.");
    requireReadinessChannelStates(canvasElement, ["unavailable", "unavailable", "unavailable"]);
  },
};

export const LongRussian: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({ locale: "ru", library: { ...library, sources: library.sources.map(row => ({ ...row, title: "Подробные заметки о происхождении доказательств, изменении версий и проверке достоверности исследовательских выводов" })) } }),
  render: (args) => (
    <div className="eliot-token-story" lang="ru">
      <ProjectsLibraryFeature {...args} />
    </div>
  ),
};

export const InteractionJourney: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({
    onReadRevision: recordAction(),
    onPreviousRevisionPage: recordAction(),
    onNextRevisionPage: recordAction(),
  }),
  play: ({ canvasElement, args }) => {
    const opened = resetAction(args.onOpenSource);
    const selected = resetAction(args.onSelectProject);
    const loaded = resetAction(args.onLoadRevisions);
    const read = resetAction(args.onReadRevision);
    const newer = resetAction(args.onPreviousRevisionPage);
    const older = resetAction(args.onNextRevisionPage);
    requireButton(canvasElement, "Notes on evidence and clear thinking").click();
    const projectLabel = Array.from(canvasElement.getElementsByTagName("label"))
      .find(label => label.textContent?.trim() === "Project");
    const project = projectLabel?.control;
    assert(project instanceof HTMLSelectElement, "Project must label the native combobox.");
    assert(project.value === "proj-0001", "The combobox must retain the caller-selected project.");
    assert(Array.from(project.options).some(option => option.value === "proj-0002" && option.text === "Model comparison"),
      "Model comparison must carry the exact existing project id.");
    const nativeEvent = project.ownerDocument.defaultView?.Event;
    assert(nativeEvent !== undefined, "The native combobox must have a document event constructor.");
    project.focus();
    project.dispatchEvent(new nativeEvent("change", { bubbles: true }));
    assert(selected.slice().length === 0, "Re-selecting the same project must not dispatch a local reset.");
    project.value = "proj-0002";
    project.dispatchEvent(new nativeEvent("change", { bubbles: true }));
    assert(selected.length === 1 && selected[0] === "proj-0002", "Native project change must dispatch the exact callback once.");
    requireButton(canvasElement, /^Versions:/).click();
    assert(opened.length === 1 && opened[0] === SOURCE_ID, "Open must use the existing source id.");
    assert(loaded.length === 1 && loaded[0] === SOURCE_ID, "Versions must use the existing source id.");
    const disclosure = Array.from(canvasElement.getElementsByTagName("summary"))
      .find(summary => summary.textContent?.trim() === "Technical details");
    assert(disclosure !== undefined, "Missing source disclosure.");
    disclosure.click();
    assert(disclosure.isConnected, "Source disclosure must remain mounted.");
    assert(requireText(canvasElement, READINESS_REF).getClientRects().length > 0, "Opened source facts must expose the readiness reference.");
    const versionDetails = requireText(canvasElement, "rev-0002-bbbb").closest("details");
    assert(versionDetails instanceof HTMLDetailsElement && !versionDetails.open,
      "Version facts must remain inside their closed native disclosure.");
    assert(requireText(canvasElement, "Currentness verified").getClientRects().length > 0, "Readiness currentness must stay visible.");
    assert(requireText(canvasElement, "High fidelity").getClientRects().length > 0, "Readiness quality must stay visible.");
    requireButton(canvasElement, "Older versions").click();
    assert(older.length === 1, "Older-page navigation must invoke its own callback once.");
    requireButton(canvasElement, "Newer versions").click();
    assert(newer.length === 1, "Prior-page navigation must invoke its own callback once.");
    requireButton(canvasElement, "Read version 1").click();
    assert(read.length === 1 && read[0] === "rev-0002-bbbb", "Read version must carry the exact revision reference.");
  },
};

export const LongRussianDark: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({ ...LongRussian.args }),
  render: args => <div data-theme="dark" lang="ru"><ProjectsLibraryFeature {...args} /></div>,
};

/**
 * Readiness and versions fail together in one pane. Each panel keeps its own visible message,
 * neither announces, and each retry invokes only its own callback.
 */
export const ReadinessAndVersionsFailed: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({
    readiness: undefined, readinessState: "degraded",
    revisions: undefined, revisionsState: "error",
    onRetryReadiness: recordAction(), onRetryRevisions: recordAction(),
  }),
  play: ({ canvasElement, args }) => {
    const panels = requirePanels(canvasElement);
    const retryReadiness = resetAction(args.onRetryReadiness);
    const retryRevisions = resetAction(args.onRetryRevisions);
    assert(requireStatus(panels.readiness, "Readiness is temporarily unavailable. You can still choose a project.").getClientRects().length > 0,
      "Readiness failure must stay visible inside its own panel.");
    // The versions panel reuses the existing library copy, so no new string is invented here.
    assert(requireStatus(panels.versions, "Sources could not be loaded.").getClientRects().length > 0,
      "Versions failure must stay visible inside its own panel.");
    requireNoAnnouncingElement(canvasElement);
    requireButton(panels.readiness, "Try again").click();
    assert(retryReadiness.length === 1 && retryRevisions.length === 0,
      "Only the readiness callback may answer the readiness panel retry.");
    requireButton(panels.versions, "Try again").click();
    assert(Number(retryRevisions.length) === 1 && retryReadiness.length === 1,
      "Only the versions callback may answer the versions panel retry; readiness stays unchanged.");
  },
};

/**
 * The same simultaneous failure in Russian: both existing localized messages stay quiet and
 * each keeps its own retry, so localization adds no announcement either.
 */
export const ReadinessAndVersionsFailedRussian: StoryObj<typeof ProjectsLibraryFeature> = {
  args: { ...ReadinessAndVersionsFailed.args, locale: "ru",
    onRetryReadiness: recordAction(), onRetryRevisions: recordAction() },
  render: args => <div className="eliot-token-story" lang="ru"><ProjectsLibraryFeature {...args} /></div>,
  play: ({ canvasElement, args }) => {
    const panels = requirePanels(canvasElement);
    const retryReadiness = resetAction(args.onRetryReadiness);
    const retryRevisions = resetAction(args.onRetryRevisions);
    assert(requireStatus(panels.readiness, "Готовность временно недоступна. Можно выбрать другой проект.").getClientRects().length > 0,
      "Russian readiness failure must stay visible.");
    assert(requireStatus(panels.versions, "Не удалось загрузить источники.").getClientRects().length > 0,
      "Russian versions failure must stay visible.");
    requireNoAnnouncingElement(canvasElement);
    requireButton(panels.readiness, "Повторить").click();
    assert(retryReadiness.length === 1 && retryRevisions.length === 0,
      "Only the Russian readiness callback may answer the readiness panel retry.");
    requireButton(panels.versions, "Повторить").click();
    assert(Number(retryRevisions.length) === 1 && retryReadiness.length === 1,
      "Only the Russian versions callback may answer the versions panel retry.");
  },
};
