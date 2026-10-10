import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type {
  WikiProposalListView,
  WikiProposalReadView,
} from "@eliotr/owner-api-client";
import {
  STUDIO_COPY,
  StudioFeature,
  type StudioFeatureProps,
} from "../../../features/studio/StudioFeature";

const meta = {
  title: "Product/Studio/Live",
  component: StudioFeature,
  decorators: [(Story) => <div className="eliot-token-story"><Story /></div>],
} satisfies Meta<typeof StudioFeature>;
export default meta;
type Story = StoryObj<typeof meta>;

/* Shaped like the accepted WikiProposalSummary values, so no ad hoc DTO is invented. */
const PROPOSALS: WikiProposalListView["items"] = [
  {
    proposal_ref: { id: "proposal-1", revision: 1 },
    page_ref: { id: "page-1", revision: 4 },
    title: "Scope discipline in research workspaces",
    page_type: "Topic",
    risk_class: "D2_ANALYTICAL",
    state: "PROPOSED",
    created_at: "2026-10-03T12:00:00.000Z",
  },
  {
    proposal_ref: { id: "proposal-2", revision: 1 },
    page_ref: { id: "page-2", revision: 7 },
    title: "Evidence freshness after a source update",
    page_type: "Report",
    risk_class: "D0_MECHANICAL",
    state: "PUBLISHED",
    created_at: "2026-10-01T12:00:00.000Z",
  },
];

/**
 * Annotated rather than as const, because the real WikiPageRevision arrays are mutable and
 * exactOptionalPropertyTypes rejects readonly arrays against them. The annotation keeps every
 * real literal value while matching the exported shape exactly.
 */
const PAGE: WikiProposalReadView["page"] = {
  page_ref: { id: "page-1", revision: 4 },
  page_type: "Topic",
  title: "Scope discipline in research workspaces",
  scope_snapshot_ref: { id: "scope-1", revision: 2 },
  body_object_ref: "body-1",
  body_sha256: "a".repeat(64),
  statement_labels: {},
  evidence_map_ref: "map-1",
  counterposition_refs: [],
  coverage_receipt_ref: { id: "coverage-1", revision: 1 },
  limitations: [],
  dependency_refs: [],
  generator_generation: "gen-1",
  status: "DRAFT",
  supersedes_ref: { id: "page-1", revision: 3 },
  publication_metadata: {},
  created_at: "2026-10-03T12:00:00.000Z",
};

const FRESH_PREVIOUS: WikiProposalReadView["source_freshness"] = {
  state: "PREVIOUS_REVISIONS",
  checked_at: "2026-10-04T12:00:00.000Z",
  changed_sources: [
    { source_id: "source-1", saved_revision_ref: "saved-1", head_revision_ref: "head-2" },
  ],
};


const noop = () => {};


/**
 * A state story that hides data omits the key entirely, because `exactOptionalPropertyTypes`
 * rejects an explicit undefined for an optional prop. Only the named keys are removed.
 */
function stateProps(state: StudioFeatureProps["state"], hidden: readonly string[]): StudioFeatureProps {
  const out: Record<string, unknown> = { ...buildProps() };
  for (const key of hidden) delete out[key];
  out.state = state;
  return out as unknown as StudioFeatureProps;
}

const BASE: StudioFeatureProps = {
  locale: "en",
  copy: STUDIO_COPY.en,
  state: "useful",
  cowVerified: true,
  onOpenProposal: noop,
  onOpenArtifact: noop,
  onCreateEdit: noop,
  onPublish: noop,
  onReviseSection: noop,
  onBack: noop,
};

/**
 * The prior head revision the root derives with the client owned pure expectedWikiHeadRevision(page).
 * It is supplied here rather than computed in the feature, so the story proves the feature forwards
 * exactly what the root supplies.
 */
const EXPECTED_PUBLISH_HEAD = 3;
const ARTIFACT_REF = { id: "artifact-1", revision: 4 };
const DECLARED_SECTIONS = ["section-1"];

const DATA: OptionalOverrides = {
  proposals: { items: PROPOSALS, has_more: false },
  selected: {
    proposal_ref: { id: "proposal-1", revision: 1 },
    page: PAGE,
    risk_class: "D2_ANALYTICAL",
    state: "PROPOSED",
    source_freshness: FRESH_PREVIOUS,
    deployment_generation: "deploy-1",
  },
  body: {
    text: "A proposal is never presented as published. Its body is read only after the digest is verified.",
    byte_length: 96,
  },
  publication: undefined,
  revise: undefined,
  expectedPublishHead: EXPECTED_PUBLISH_HEAD,
  artifactRef: ARTIFACT_REF,
  declaredSectionRefs: DECLARED_SECTIONS,
};

function buildProps(overrides: Partial<StudioFeatureProps> = {}): StudioFeatureProps {
  return { ...BASE, ...dropUndefined(DATA), ...overrides };
}

export const Useful: Story = { args: buildProps() };

export const Loading: Story = { args: stateProps("loading", ["selected", "body"]) };

export const Empty: Story = { args: stateProps("empty", ["proposals", "selected", "body"]) };

/** A previous-revision source must read as earlier sources, never as a color alone. */
export const Degraded: Story = { args: buildProps({ state: "degraded" }) };

export const Error: Story = { args: stateProps("error", ["selected", "body"]) };

export const LongRussian: Story = {
  args: buildProps({
    locale: "ru",
    copy: STUDIO_COPY.ru,
    selected: {
      proposal_ref: { id: "proposal-1", revision: 1 },
      page: {
        ...PAGE,
        title: "Дисциплина области исследования в исследовательском рабочем пространстве проекта",
      },
      risk_class: "D2_ANALYTICAL",
      state: "PROPOSED",
      source_freshness: FRESH_PREVIOUS,
      deployment_generation: "deploy-1",
    },
  }),
};

/** A published proposal is never given a publish button, whatever else is true. */
export const PublishedHasNoPublish: Story = {
  args: buildProps({
    selected: {
      proposal_ref: { id: "proposal-2", revision: 1 },
      page: { ...PAGE, status: "PUBLISHED" },
      risk_class: "D0_MECHANICAL",
      state: "PUBLISHED",
      source_freshness: {
        state: "CURRENT_REVISIONS",
        checked_at: "2026-10-04T12:00:00.000Z",
        changed_sources: [],
      },
      deployment_generation: "deploy-1",
    },
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button", { name: STUDIO_COPY.en.publish })).not.toBeInTheDocument();
    await expect(canvas.getByText(STUDIO_COPY.en.publish_not_draft)).toBeVisible();
  },
};

/**
 * Mandatory negative: there is no regenerate endpoint, so no control in the tree may offer one. This
 * asserts absence by role and name rather than by a snapshot that could drift.
 */
export const NoRegenerateControl: Story = {
  args: buildProps(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of ["Regenerate", "regenerate", "Регенерировать", "Generate"]) {
      await expect(canvas.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    await expect(canvas.queryByText(/regenerate/iu)).not.toBeInTheDocument();
    // The implemented actions remain.
    await expect(canvas.getByRole("button", { name: STUDIO_COPY.en.create_edit })).toBeVisible();
  },
};

const publishSpy = fn();
const openSpy = fn();
const reviseSpy = fn();

/**
 * Copy-on-write is typed: the edit callback carries the exact base lineage and expected head revision,
 * so a caller can never pass a base page whose revision does not match the request.
 */
export const EditCarriesExactLineage: Story = {
  args: buildProps(),
  render: () => {
    function Harness() {
      return (
        <StudioFeature
          {...buildProps()}
          onCreateEdit={(intent) => {
            publishSpy(intent);
          }}
        />
      );
    }
    return <Harness />;
  },
  play: async ({ canvasElement }) => {
    publishSpy.mockClear(); openSpy.mockClear();
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: STUDIO_COPY.en.create_edit }));
    await expect(publishSpy).toHaveBeenCalledTimes(1);
    const expected = buildProps();
    if (!expected.selected || !expected.body) throw new globalThis.Error("Verified edit fixture is missing");
    await expect(publishSpy).toHaveBeenCalledWith({
      baseProposalRef: expected.selected.proposal_ref, basePageRef: PAGE.page_ref,
      expectedHeadRevision: PAGE.page_ref.revision, title: PAGE.title,
      bodyText: expected.body.text, editNote: "",
    });
    await expect(openSpy).not.toHaveBeenCalled();
  },
};

/** Publish requires an explicit second step, so a single click never publishes. */
export const PublishNeedsConfirmation: Story = {
  args: buildProps(),
  render: () => {
    function Harness() {
      return (
        <StudioFeature
          {...buildProps()}
          onPublish={() => {
            publishSpy();
          }}
          onReviseSection={() => reviseSpy()}
          onOpenArtifact={() => openSpy()}
        />
      );
    }
    return <Harness />;
  },
  play: async ({ canvasElement }) => {
    publishSpy.mockClear();
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: STUDIO_COPY.en.publish }));
    // The first click only opens the review; nothing is published yet.
    await expect(publishSpy).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("button", { name: STUDIO_COPY.en.publish_confirm }));
    await expect(publishSpy).toHaveBeenCalledTimes(1);
  },
};

/** An uncertain section effect is a state, and never silently retried by the feature. */
export const UncertainSectionEffect: Story = {
  args: buildProps({ revise: {
    operation_id: "operation-1",
    attempt_ref: "attempt-1",
    state: "UNKNOWN",
  } }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(STUDIO_COPY.en.revise_unknown)).toBeVisible();
    await expect(canvas.queryByText(STUDIO_COPY.en.revise_committed)).not.toBeInTheDocument();
  },
};

/** A missing publication is not a failure, and it is never shown as complete. */
export const NoPublicationIsNotComplete: Story = {
  args: buildProps({ publication: null }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(STUDIO_COPY.en.publication_none)).toBeVisible();
    await expect(canvas.queryByText(STUDIO_COPY.en.publication_accepted)).not.toBeInTheDocument();
  },
};

/**
 * Optional props are omitted rather than set to undefined, because the owning tsconfig enables
 * `exactOptionalPropertyTypes` and an explicit undefined is not assignable to an optional prop.
 * The overrides type therefore treats undefined as "drop this key", which is what a state story
 * that hides data actually means.
 */
type OptionalOverrides = {
  readonly proposals?: Partial<StudioFeatureProps["proposals"]> | undefined;
  readonly selected?: StudioFeatureProps["selected"];
  readonly body?: StudioFeatureProps["body"];
  readonly publication?: StudioFeatureProps["publication"];
  readonly revise?: StudioFeatureProps["revise"];
  readonly expectedPublishHead?: number;
  readonly artifactRef?: StudioFeatureProps["artifactRef"];
  readonly declaredSectionRefs?: readonly string[];
};

function dropUndefined(values: OptionalOverrides): Partial<StudioFeatureProps> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(values)) {
    const value = (values as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<StudioFeatureProps>;
}

/** Draft fields stay local until explicit Create forwards their chosen content and base lineage. */
const EDIT_REVIEW_LOCALES = ["en", "ru"] as const;
const EDIT_REVIEW_VALUES = {
  en: {
    title: "Edited scope discipline",
    bodyText: "This edited draft preserves the saved page.\nThe next line records the evidence limitation.",
    editNote: "Clarify scope without changing the saved revision.",
  },
  ru: {
    title: "Уточнённая область исследования и ограничения выводов для выбранных источников",
    bodyText: "Сохранённая страница остаётся прежней; эти изменения относятся только к новому черновику.\nВо второй строке указаны проверяемые основания, ограничения выводов и необходимость явной проверки перед публикацией.",
    editNote: "Уточнить область и сохранить прежнюю страницу без автоматической публикации.",
  },
};
const EDIT_REVIEW_SPIES = {
  verified: { en: { create: fn(), publish: fn() }, ru: { create: fn(), publish: fn() } },
  missing: { en: { create: fn(), publish: fn() }, ru: { create: fn(), publish: fn() } },
};

/** Keep accepted fixtures; omit optional artifact capabilities and absent body. */
function editReviewProps(locale: StudioFeatureProps["locale"], verifiedBody: boolean): StudioFeatureProps {
  const {
    body, expectedPublishHead,
    artifactRef: _artifactRef, declaredSectionRefs: _declaredSectionRefs,
    onOpenArtifact: _onOpenArtifact, onReviseSection: _onReviseSection,
    ...props
  } = buildProps({ locale, copy: STUDIO_COPY[locale] });
  return {
    ...props,
    cowVerified: verifiedBody,
    ...(verifiedBody && body !== undefined ? { body } : {}),
    ...(verifiedBody && expectedPublishHead !== undefined ? { expectedPublishHead } : {}),
  };
}

/** Independent editors; the original proposal/page refs are shared fixture values. */
function StudioEditReviewPair({ verifiedBody }: { readonly verifiedBody: boolean }) {
  const spies = verifiedBody ? EDIT_REVIEW_SPIES.verified : EDIT_REVIEW_SPIES.missing;
  return <>{EDIT_REVIEW_LOCALES.map(locale => <StudioFeature
    key={locale}
    {...editReviewProps(locale, verifiedBody)}
    onCreateEdit={spies[locale].create}
    onPublish={spies[locale].publish}
  />)}</>;
}

/** Typing is local; only explicit Create forwards exact edited content/lineage. */
export const EditReviewBeforeCreate: Story = {
  args: editReviewProps("en", true),
  render: () => <StudioEditReviewPair verifiedBody />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const locale of EDIT_REVIEW_LOCALES) {
      const copy = STUDIO_COPY[locale], values = EDIT_REVIEW_VALUES[locale];
      const spy = EDIT_REVIEW_SPIES.verified[locale];
      spy.create.mockClear(); spy.publish.mockClear();
      const feature = within(canvas.getByRole("region", { name: copy.title }));
      const editSection = feature.getByRole("region", { name: copy.edit_note_label });
      const edit = within(editSection);
      const title = edit.getByRole("textbox", { name: copy.edit_title_label });
      const text = edit.getByRole("textbox", { name: copy.edit_body_field_label });
      const note = edit.getByRole("textbox", { name: copy.edit_note_field_label });
      const create = edit.getByRole("button", { name: copy.create_edit });
      await expect(editSection).toBeVisible();
      for (const input of [title, text, note]) await expect(input).toBeVisible();
      await userEvent.clear(title); await userEvent.type(title, values.title);
      await userEvent.clear(text); await userEvent.type(text, values.bodyText);
      await userEvent.clear(note); await userEvent.type(note, values.editNote);
      await expect(title).toHaveValue(values.title);
      await expect(text).toHaveValue(values.bodyText);
      await expect(note).toHaveValue(values.editNote);
      await expect(spy.create).not.toHaveBeenCalled();
      await expect(spy.publish).not.toHaveBeenCalled();
      await expect(feature.getByRole("heading", { name: PAGE.title, level: 3 })).toBeVisible();
      await expect(feature.queryByRole("button", { name: copy.open_artifact })).not.toBeInTheDocument();
      await expect(feature.queryByRole("button", { name: copy.revise_section })).not.toBeInTheDocument();
      await expect(create).toBeEnabled();
      await userEvent.click(create);
      const expected = editReviewProps(locale, true);
      if (!expected.selected) throw new globalThis.Error("Selected edit-review fixture is missing");
      await expect(spy.create).toHaveBeenCalledTimes(1);
      await expect(spy.create).toHaveBeenCalledWith({
        baseProposalRef: expected.selected.proposal_ref,
        basePageRef: expected.selected.page.page_ref,
        expectedHeadRevision: expected.selected.page.page_ref.revision,
        title: values.title, bodyText: values.bodyText, editNote: values.editNote,
      });
      await expect(spy.publish).not.toHaveBeenCalled();
    }
  },
};

/** Entered text cannot stand in for a missing digest-verified supplied body. */
export const EditReviewRequiresVerifiedBody: Story = {
  args: editReviewProps("en", false),
  render: () => <StudioEditReviewPair verifiedBody={false} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const locale of EDIT_REVIEW_LOCALES) {
      const copy = STUDIO_COPY[locale], values = EDIT_REVIEW_VALUES[locale];
      const spy = EDIT_REVIEW_SPIES.missing[locale];
      spy.create.mockClear(); spy.publish.mockClear();
      const feature = within(canvas.getByRole("region", { name: copy.title }));
      const editSection = feature.getByRole("region", { name: copy.edit_note_label });
      const edit = within(editSection);
      const create = edit.getByRole("button", { name: copy.create_edit });
      await expect(editSection).toBeVisible();
      await expect(feature.getByText(copy.body_unavailable, { exact: true })).toBeVisible();
      await expect(create).toBeDisabled();
      await userEvent.type(edit.getByRole("textbox", { name: copy.edit_title_label }), values.title);
      await userEvent.type(edit.getByRole("textbox", { name: copy.edit_body_field_label }), values.bodyText);
      await userEvent.type(edit.getByRole("textbox", { name: copy.edit_note_field_label }), values.editNote);
      await expect(create).toBeDisabled();
      await userEvent.click(create);
      await expect(spy.create).not.toHaveBeenCalled();
      await expect(spy.publish).not.toHaveBeenCalled();
      await expect(feature.queryByRole("button", { name: copy.publish })).not.toBeInTheDocument();
      await expect(feature.queryByRole("button", { name: copy.open_artifact })).not.toBeInTheDocument();
      await expect(feature.queryByRole("button", { name: copy.revise_section })).not.toBeInTheDocument();
    }
  },
};
