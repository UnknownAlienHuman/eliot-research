import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
  REPORT_COPY,
  ReportFeature,
  type ReportFeatureProps,
  type ReportSectionRow,
} from "../../../features/research/report/ReportFeature";
import type { ArtifactSectionResponse, DeclaredSection } from "@eliotr/owner-api-client";

const meta = {
  title: "Product/Report",
  component: ReportFeature,
  decorators: [(Story) => <div className="eliot-token-story"><Story /></div>],
} satisfies Meta<typeof ReportFeature>;
export default meta;
type Story = StoryObj<typeof meta>;

const ARTIFACT_REF = { id: "report-1", revision: 3 };

function section(id: string, objectRef: string): DeclaredSection {
  return {
    section_ref: { id, revision: 1 },
    body_object_ref: objectRef,
    body_sha256: "0".repeat(64),
  };
}

function readBack(row: DeclaredSection): ArtifactSectionResponse {
  return {
    artifact_ref: ARTIFACT_REF,
    section_ref: row.section_ref,
    body_object_ref: row.body_object_ref,
    body_sha256: row.body_sha256,
    size_bytes: 0,
    bytes: new Uint8Array(),
  };
}

const DECLARED_A = section("sec-1", "sections/overview.md");
const DECLARED_B = section("sec-2", "sections/claims.md");
function manifestFor(declared: readonly DeclaredSection[]) {
  return {
    artifact_ref: ARTIFACT_REF,
    title: "Research report draft",
    created_at: "2026-10-10T09:00:00.000Z",
    sections: declared,
  };
}

const NO_SECTIONS: readonly ReportSectionRow[] = [
  { section: DECLARED_A, read: undefined },
  { section: DECLARED_B, read: undefined },
];


function buildProps(overrides: Partial<ReportFeatureProps> = {}): ReportFeatureProps {
  return {
    locale: "en",
    copy: REPORT_COPY.en,
    state: "useful",
    sections: NO_SECTIONS,
    freshness: "CURRENT_REVISIONS",
    onReadSection: () => {},
    onOpenManifest: () => {},
    onExport: () => {},
    ...overrides,
  };
}

export const Useful: Story = {
  args: buildProps({
    manifest: manifestFor([DECLARED_A, DECLARED_B]),
  }),
};

export const Loading: Story = {
  args: buildProps({ state: "loading" }),
};

export const Empty: Story = {
  args: buildProps({ state: "empty", sections: [] }),
};

export const Degraded: Story = {
  args: buildProps({
    state: "degraded",
    sections: [],
    freshness: "UNKNOWN",
  }),
};

export const Error: Story = {
  args: buildProps({
    state: "error",
    sections: [],
    rejectedSectionRef: "sec-1:1",
  }),
};

/** Long Russian manifest and sections, with freshness left unresolved. */
const RU_LONG_SECTIONS: readonly ReportSectionRow[] = [
  {
    section: section(
      "sec-long-1",
      "sections/очень-длинный-идентификатор-тела-раздела-для-проверки-переноса-0001.json",
    ),
    read: undefined,
  },
  {
    section: section(
      "sec-long-2",
      "sections/ещё-один-очень-длинный-идентификатор-тела-раздела-для-проверки-переноса-0002.json",
    ),
    read: undefined,
  },
];

export const LongRussian: Story = {
  args: buildProps({
    locale: "ru",
    copy: REPORT_COPY.ru,
      manifest: manifestFor(RU_LONG_SECTIONS.map((row) => row.section)),
    sections: RU_LONG_SECTIONS,
    freshness: "UNKNOWN",
  }),
};

const readSpy = fn();
const exportSpy = fn();

/** Mandatory negative interaction: a required section that was never read back blocks export. */
export const ExportBlockedByUnreadSection: Story = {
  args: buildProps({
    manifest: manifestFor([DECLARED_A, DECLARED_B]),
    sections: NO_SECTIONS,
    freshness: "UNKNOWN",
    onExport: exportSpy,
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Completeness is honest about what is missing, and UNKNOWN freshness stays visible.
    await expect(canvas.getByText("Some declared sections are not read back yet.")).toBeVisible();
    await expect(canvas.getByText("Unknown")).toBeVisible();
    // The blocked export is disabled, so no partial report can leave the panel.
    await expect(canvas.getByRole("button", { name: "Export report" })).toBeDisabled();
    await userEvent.click(canvas.getByRole("button", { name: "Export report" }), { pointerEventsCheck: 0 });
    await expect(exportSpy).not.toHaveBeenCalled();
  },
};

/** Reading every declared section back unlocks the export through the real callback. */
function CompleteReportHarness() {
  const [sections, setSections] = useState<readonly ReportSectionRow[]>(NO_SECTIONS);
  return (
    <ReportFeature
      locale="en"
      copy={REPORT_COPY.en}
      state="useful"
      manifest={manifestFor(NO_SECTIONS.map((row) => row.section))}
      sections={sections}
      freshness="CURRENT_REVISIONS"
      onReadSection={(declared) => {
        readSpy();
        setSections((current) =>
          current.map((row) =>
            row.section.section_ref.id === declared.section_ref.id
              ? { section: row.section, read: readBack(row.section) }
              : row));
      }}
      onOpenManifest={() => {}}
      onExport={() => exportSpy()}
    />
  );
}

export const CompleteAfterReadback: Story = {
  args: buildProps(),
  render: () => <CompleteReportHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const readName = (ordinal: number) => `${REPORT_COPY.en.readSection} · ${REPORT_COPY.en.sectionOrdinal(ordinal)}`;
    const unreadButtons = () => [1, 2].flatMap((ordinal) => canvas.queryAllByRole("button", { name: readName(ordinal) }));
    readSpy.mockClear(); exportSpy.mockClear();
    await expect(canvas.getByRole("button", { name: "Export report" })).toBeDisabled();
    const first = canvas.getByRole("button", { name: readName(1) });
    if (!first) throw new globalThis.Error("First declared section is missing");
    await userEvent.click(first);
    await waitFor(() => expect(unreadButtons().length).toBe(1));
    const second = canvas.getByRole("button", { name: readName(2) });
    if (!second) throw new globalThis.Error("Second declared section is missing");
    await userEvent.click(second);
    await waitFor(() => expect(unreadButtons().length).toBe(0));
    await expect(canvas.getByRole("button", { name: "Export report" })).toBeEnabled();
    await userEvent.click(canvas.getByRole("button", { name: "Export report" }));
    await expect(exportSpy).toHaveBeenCalledTimes(1);
    await expect(readSpy).toHaveBeenCalledTimes(2);
  },
};

/** A caller cannot shorten the manifest-required set, duplicate a row or use a foreign parent. */
export const PartialRowsCannotComplete: Story = {
  args: buildProps({ manifest: manifestFor([DECLARED_A, DECLARED_B]), sections: [{ section: DECLARED_A, read: readBack(DECLARED_A) }] }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("2 declared")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Export report" })).toBeDisabled();
  },
};
export const DuplicateRowsCannotComplete: Story = {
  args: buildProps({ manifest: manifestFor([DECLARED_A, DECLARED_B]), sections: [
    { section: DECLARED_A, read: readBack(DECLARED_A) }, { section: DECLARED_A, read: readBack(DECLARED_A) },
  ] }),
  play: async ({ canvasElement }) => { await expect(within(canvasElement).getByRole("button", { name: "Export report" })).toBeDisabled(); },
};
export const ForeignArtifactCannotComplete: Story = {
  args: buildProps({ manifest: manifestFor([DECLARED_A]), sections: [{ section: DECLARED_A,
    read: { ...readBack(DECLARED_A), artifact_ref: DECLARED_A.section_ref } }] }),
  play: async ({ canvasElement }) => { await expect(within(canvasElement).getByRole("button", { name: "Export report" })).toBeDisabled(); },
};

/** Three accepted fixture rows keep the middle action distinct from its neighbours. */
const SECTION_ACTION_ROWS: readonly ReportSectionRow[] = [
  ...NO_SECTIONS,
  ...RU_LONG_SECTIONS.slice(0, 1),
];
const sectionActionReadSpy = fn<(declared: DeclaredSection) => void>();
const sectionActionExportSpy = fn();
const sectionActionManifestSpy = fn();

/** Hold the read, then supply the existing matching readback fixture through props. */
function SectionActionsTargetHarness({ locale }: Pick<ReportFeatureProps, "locale">) {
  const [rows, setRows] = useState<readonly ReportSectionRow[]>(SECTION_ACTION_ROWS);
  const [readingRef, setReadingRef] = useState<ReportFeatureProps["readingRef"]>();
  return <>
    <ReportFeature {...buildProps({
      locale,
      copy: REPORT_COPY[locale],
      manifest: manifestFor(SECTION_ACTION_ROWS.map((row) => row.section)),
      sections: rows,
      readingRef,
      onReadSection: (declared) => {
        sectionActionReadSpy(declared);
        setReadingRef(`${declared.section_ref.id}:${declared.section_ref.revision}`);
      },
      onOpenManifest: sectionActionManifestSpy,
      onExport: sectionActionExportSpy,
    })} />
    <button type="button" onClick={() => {
      setRows((current) => current.map((row) => row.section === DECLARED_B
        ? { section: row.section, read: readBack(row.section) }
        : row));
      setReadingRef(undefined);
    }}>
      Fixture: supply second-section readback
    </button>
  </>;
}

/** Visible ordinal labels select the exact declared section for both Read and Open. */
export const SectionActionsIdentifyExactTarget: Story = {
  args: buildProps({
    manifest: manifestFor(SECTION_ACTION_ROWS.map((row) => row.section)),
    sections: SECTION_ACTION_ROWS,
  }),
  render: (args) => <SectionActionsTargetHarness locale={args.locale} />,
  play: async ({ canvasElement, args }) => {
    sectionActionReadSpy.mockClear();
    sectionActionExportSpy.mockClear();
    sectionActionManifestSpy.mockClear();
    const canvas = within(canvasElement);
    const copy = REPORT_COPY[args.locale];
    const report = within(canvas.getByRole("region", { name: copy.title }));
    const readName = (ordinal: number) => `${copy.readSection} · ${copy.sectionOrdinal(ordinal)}`;
    await expect(report.getByText(copy.sectionsCount(3))).toBeVisible();
    const second = report.getByRole("button", { name: readName(2) });
    await expect(second).toBeVisible();
    await expect(second).toHaveTextContent(copy.sectionOrdinal(2));
    await expect(second).toBeEnabled();
    await expect(sectionActionReadSpy).not.toHaveBeenCalled();

    second.focus();
    await expect(second).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    const readingSecond = await report.findByRole("button", {
      name: `${copy.readingSection} · ${copy.sectionOrdinal(2)}`,
    });
    await expect(readingSecond).toBeDisabled();
    for (const ordinal of [1, 3]) {
      await expect(report.getByRole("button", { name: readName(ordinal) })).toBeEnabled();
    }
    await expect(sectionActionReadSpy.mock.calls).toEqual([[DECLARED_B]]);
    await expect(report.getByRole("button", { name: copy.export })).toBeDisabled();

    await userEvent.click(canvas.getByRole("button", {
      name: "Fixture: supply second-section readback",
    }));
    const openSecond = await report.findByRole("button", {
      name: `${copy.openSection} · ${copy.sectionOrdinal(2)}`,
    });
    await expect(openSecond).toBeVisible();
    await expect(openSecond).toHaveTextContent(copy.sectionOrdinal(2));
    await expect(openSecond).toBeEnabled();
    await expect(sectionActionReadSpy.mock.calls).toEqual([[DECLARED_B]]);
    for (const ordinal of [1, 3]) {
      await expect(report.getByRole("button", { name: readName(ordinal) })).toBeEnabled();
    }
    await expect(report.getByRole("button", { name: copy.export })).toBeDisabled();

    openSecond.focus();
    await expect(openSecond).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(sectionActionReadSpy.mock.calls).toEqual([[DECLARED_B], [DECLARED_B]]);
    await expect(sectionActionExportSpy).not.toHaveBeenCalled();
    await expect(sectionActionManifestSpy).not.toHaveBeenCalled();
  },
};


export const SectionActionsIdentifyExactTargetRu: Story = {
  ...SectionActionsIdentifyExactTarget,
  args: buildProps({
    locale: "ru",
    copy: REPORT_COPY.ru,
    manifest: manifestFor(SECTION_ACTION_ROWS.map((row) => row.section)),
    sections: SECTION_ACTION_ROWS,
  }),
};
