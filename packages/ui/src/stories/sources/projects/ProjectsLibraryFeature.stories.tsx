// U3-P Projects Library feature stories. Real DTO props, offline, no query client.
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, fn } from "storybook/test";
import type { LibraryPage, LibraryReadinessView, SourceRevisionPage, ProjectListView } from "@eliotr/owner-api-client";
import { ProjectsLibraryFeature, type ProjectsLibraryFeatureProps } from "../../../features/sources/projects/ProjectsLibraryFeature";

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

const blockedReadiness: LibraryReadinessView = {
  ...readyReadiness,
  channels: [channel("exact_ready", "ready", "gen-1", "rc-1"), channel("lexical_ready", "failed"), channel("semantic_ready", "ready", "gen-1", "rc-3")],
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
    onSelectProject: fn(),
    library,
    readiness: readyReadiness,
    readinessState: "useful",
    revisions,
    revisionsState: "useful",
    selectedSourceId: SOURCE_ID,
    onOpenSource: fn(),
    onLoadRevisions: fn(),
    onRetry: () => {},
    ...args,
  };
}

export const Populated: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({}),
};

export const Loading: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({ state: "loading", library: undefined }),
};

export const Empty: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({ library: { ...library, sources: [] } }),
};

export const Degraded: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({ state: "degraded", readiness: undefined, readinessState: "degraded" }),
};

export const Error: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({ state: "error", library: undefined }),
};

export const ReadinessBlocked: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({ readiness: blockedReadiness }),
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
  args: base({ onReadRevision: fn() }),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const notes = canvas.getByRole("button", { name: "Notes on evidence and clear thinking" });
    await userEvent.click(notes);
    const second = canvas.getByRole("button", { name: "Model comparison" });
    await userEvent.click(second);
    const versions = canvas.getByRole("button", { name: /^Versions:/ });
    await userEvent.click(versions);
    await expect(args.onOpenSource).toHaveBeenCalledWith(SOURCE_ID);
    await expect(args.onSelectProject).toHaveBeenCalledWith("proj-0002");
    await expect(args.onLoadRevisions).toHaveBeenCalledWith(SOURCE_ID);
    const disclosure = canvas.getAllByText("Technical details")[0];
    if (!disclosure) throw new globalThis.Error("Missing source disclosure");
    await userEvent.click(disclosure);
    await expect(disclosure).toBeInTheDocument();
    const readinessRef = canvas.getByText(READINESS_REF);
    await expect(readinessRef).toBeVisible();
    const revisionRef = canvas.getByText("rev-0002-bbbb");
    await expect(revisionRef).not.toBeVisible();
    await expect(canvas.getByText("Currentness verified")).toBeVisible();
    await expect(canvas.getByText("High fidelity")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Read version 1" }));
    await expect(args.onReadRevision).toHaveBeenCalledWith("rev-0002-bbbb");
  },
};

export const LongRussianDark: StoryObj<typeof ProjectsLibraryFeature> = {
  args: base({ ...LongRussian.args }),
  render: args => <div data-theme="dark" lang="ru"><ProjectsLibraryFeature {...args} /></div>,
};
