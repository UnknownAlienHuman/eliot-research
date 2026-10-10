import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ERASURE_COPY, ErasureFeature, type ErasureFeatureProps } from "../../../features/sources/erasure/ErasureFeature";

const meta = {
  title: "Product/Erasure",
  component: ErasureFeature,
  decorators: [(Story) => <div className="eliot-token-story"><Story /></div>],
} satisfies Meta<typeof ErasureFeature>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Shaped like the accepted ErasurePrepareView, whose request is an OwnerErasureCommand. */
const PREPARED = {
  source_title: "Quarterly infrastructure audit",
  source_id: "src-1",
  revision_targets: ["rev-1", "rev-2", "rev-3"],
  request: {
    protocol: "eliotr.owner-erasure.v1" as const,
    permission_ref: { id: "perm-1", revision: 1 },
    request: {
      protocol: "erc.privacy.erasure.v1" as const,
      erasure_ref: { id: "ers-1", revision: 1 },
      requested_by_principal_ref: "prn-1",
      exact_subject_refs: ["subject-1", "subject-2"],
      required_locations: ["CanonicalPayload", "Blob"],
      legal_basis_ref: "basis-1",
      admitted_at: "2026-10-09T00:00:00.000Z",
      deadline: "2026-10-17T00:00:00.000Z",
    },
  },
} satisfies ErasureFeatureProps["prepared"];

/** Long Russian source title, refs and locations, for the wrap and 320px checks. */
const RU_LONG_PREPARED = {
  ...PREPARED,
  source_title: "Ежеквартальный отчёт об аудите инфраструктуры исследовательской рабочей области",
  revision_targets: Array.from({ length: 14 }, (_unused, index) => `revision-${index + 1}`),
  request: {
    ...PREPARED.request,
    permission_ref: { id: "permission-very-long-reference-identifier-0001", revision: 12 },
    request: {
      ...PREPARED.request.request,
      required_locations: ["CanonicalPayload", "Projection", "Index", "Blob", "OperationalRecovery", "ProviderCopy", "BackupRestorePath", "RouteContinuation"],
    },
  },
} satisfies ErasureFeatureProps["prepared"];

/** Shaped like the accepted ErasureStatusView with a blocked terminal receipt. */
const BLOCKED_STATUS = {
  state: "BLOCKED",
  receipt: {
    protocol: "erc.privacy.erasure.v1" as const,
    erasure_ref: { id: "ers-1", revision: 1 },
    state: "BLOCKED" as const,
    requested_locations: ["CanonicalPayload", "Blob"],
    completed_locations: ["CanonicalPayload"],
    blocked_locations: [{ location: "Blob", policy_or_hold_ref: "hold-1", next_review_at: "2026-11-10T00:00:00.000Z" }],
    purge_ledger_entry_ref: "ledger-1",
    issued_at: "2026-10-10T00:00:00.000Z",
  },
} satisfies ErasureFeatureProps["status"];

/** A completed terminal status, used to prove no destructive button survives success. */
const COMPLETE_STATUS = {
  state: "COMPLETE",
  receipt: {
    protocol: "erc.privacy.erasure.v1" as const,
    erasure_ref: { id: "ers-1", revision: 1 },
    state: "COMPLETE" as const,
    requested_locations: ["CanonicalPayload", "Blob"],
    completed_locations: ["CanonicalPayload", "Blob"],
    blocked_locations: [],
    purge_ledger_entry_ref: "ledger-2",
    issued_at: "2026-10-11T00:00:00.000Z",
  },
} satisfies ErasureFeatureProps["status"];

function buildProps(overrides: Partial<ErasureFeatureProps> = {}): ErasureFeatureProps {
  return {
    locale: "en",
    copy: ERASURE_COPY.en,
    state: "useful",
    hasSavedStatus: false,
    reviewOpen: false,
    onReview: () => {},
    onConfirm: () => {},
    onCancel: () => {},
    onRefresh: () => {},
    onToggleDisclosure: () => {},
    ...overrides,
  };
}

export const Useful: Story = {
  args: buildProps({ prepared: PREPARED, hasSavedStatus: false }),
};

export const Loading: Story = {
  args: buildProps({ state: "loading", hasSavedStatus: true }),
};

export const Empty: Story = {
  args: buildProps({ state: "empty" }),
};

export const Degraded: Story = {
  args: buildProps({ state: "degraded", hasSavedStatus: true, status: { state: "UNKNOWN" } }),
};

export const Error: Story = {
  args: buildProps({ state: "error", hasSavedStatus: true, status: BLOCKED_STATUS }),
};

export const LongRussian: Story = {
  args: buildProps({
    locale: "ru",
    copy: ERASURE_COPY.ru,
    prepared: RU_LONG_PREPARED,
    reviewOpen: true,
    hasSavedStatus: true,
    status: { state: "UNKNOWN" },
  }),
};

/** The dark token wrapper is data-theme, so no palette is invented here. */
export const LongRussianDarkNarrow: Story = {
  args: buildProps({
    locale: "ru",
    copy: ERASURE_COPY.ru,
    prepared: RU_LONG_PREPARED,
    reviewOpen: true,
    hasSavedStatus: true,
    status: { state: "UNKNOWN" },
  }),
  decorators: [
    (Story) => (
      <div data-theme="dark">
        <Story />
      </div>),
  ],
};

const confirmSpy = fn();
const reviewSpy = fn();

/** A state harness around the real component, so assertions exercise the feature itself. */
function ErasureHarness() {
  const [reviewOpen, setReviewOpen] = useState(false);
  return (
    <ErasureFeature
      locale="en"
      copy={ERASURE_COPY.en}
      state="useful"
      prepared={PREPARED}
      hasSavedStatus={false}
      reviewOpen={reviewOpen}
      onReview={() => reviewSpy()}
      onConfirm={() => confirmSpy()}
      onCancel={() => setReviewOpen(false)}
      onRefresh={() => {}}
      onToggleDisclosure={() => setReviewOpen((open) => !open)}
    />
  );
}

export const ErasureInteraction: Story = {
  args: buildProps(),
  render: () => <ErasureHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The exact source title and the revision count are readable before any confirm.
    await expect(canvas.getByText(PREPARED.source_title)).toBeVisible();
    await expect(canvas.getByText("3")).toBeVisible();
    await expect(canvas.getByText("Blob")).toBeVisible();
    // Confirming is destructive, so it must reach the real callback exactly once.
    await userEvent.click(canvas.getByRole("button", { name: ERASURE_COPY.en.confirm }));
    await expect(confirmSpy).toHaveBeenCalledTimes(1);
    // Disclosure stays closed until the reader asks for it.
    await expect(canvas.queryByText(ERASURE_COPY.en.disclosure_legal_basis)).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: ERASURE_COPY.en.review_disclosure }));
    await expect(canvas.getByText(ERASURE_COPY.en.disclosure_legal_basis)).toBeVisible();
    await expect(canvas.getByText("basis-1")).toBeVisible();
  },
};

/** Partial progress and a blocked outcome must never render as complete. */
export const BlockedNeverComplete: Story = {
  args: buildProps({
    state: "error",
    hasSavedStatus: true,
    status: BLOCKED_STATUS,
    completeVerified: true,
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText(ERASURE_COPY.en.complete_verified)).not.toBeInTheDocument();
    await expect(canvas.getByText(ERASURE_COPY.en.blocked)).toBeVisible();
    await expect(canvas.getByText("Blob")).toBeVisible();
    // A blocked outcome leaves no destructive action behind.
    await expect(canvas.queryByRole("button", { name: ERASURE_COPY.en.confirm })).not.toBeInTheDocument();
  },
};

/** A verified completion must not offer the destructive action again. */
export const CompleteLeavesNoConfirm: Story = {
  args: buildProps({
    state: "useful",
    prepared: PREPARED,
    hasSavedStatus: true,
    status: COMPLETE_STATUS,
    completeVerified: true,
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(ERASURE_COPY.en.complete_verified)).toBeVisible();
    await expect(canvas.queryByRole("button", { name: ERASURE_COPY.en.confirm })).not.toBeInTheDocument();
  },
};
