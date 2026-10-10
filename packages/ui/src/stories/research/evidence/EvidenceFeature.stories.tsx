import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type {
  CitationResolutionOutcome,
  CitedEvidence,
  ReauthorizedCitedEvidence,
} from '@eliotr/owner-api-client';
import {
  EvidenceFeature,
  type EvidenceRow,
} from '../../../features/research/evidence/EvidenceFeature';

const meta = {
  title: 'Product/Research/Evidence',
  component: EvidenceFeature,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof EvidenceFeature>;
export default meta;
type Story = StoryObj<typeof meta>;

const handle = { id: 'excerpt-one', revision: 4 };
const otherHandle = { id: 'excerpt-two', revision: 9 };
const digest = '3925c7459df98819eb36d410268b17857f6ccbc9ea3e0b7df415db24ad559ec0';
const russianExcerpt =
  'Каждый отчёт сохраняет выбранные версии источников. Новая версия не изменяет уже сделанные выводы.';

const citation: CitedEvidence = { handle_ref: handle, excerpt_sha256: digest };

const resolved: CitationResolutionOutcome = {
  handle_ref: handle,
  outcome: 'RESOLVED',
  excerpt_sha256: digest,
  verification_receipt_ref: 'verify-receipt-one',
};

const reauthorized: ReauthorizedCitedEvidence = {
  original_handle_ref: handle,
  handle_ref: otherHandle,
  excerpt_sha256: digest,
};

const claim = {
  claim_ref: { id: 'claim-one', revision: 2 },
  claim_text: 'The saved scope of an earlier report is never rewritten by a later source revision.',
  claim_text_digest: '7'.repeat(64),
  disposition: 'SUPPORTED' as const,
  support_handle_refs: [handle],
  counterevidence_handle_refs: [],
};


const opened = (overrides: Partial<EvidenceRow['opened']> = {}) => ({
  text: 'The saved scope of the report is frozen with its sources.',
  handleRef: handle,
  excerptSha256: digest,
  verificationReceiptRef: 'verify-receipt-one',
  ...overrides,
});

// A typed base row. Every story starts from a complete citation, so no partial spread can produce a
// row whose citation is missing, and each story varies only the fields it names.
const baseRow = (overrides: Partial<EvidenceRow> = {}): EvidenceRow => ({
  citation,
  outcome: resolved,
  ...overrides,
});

const rows = (...variants: readonly Partial<EvidenceRow>[]): EvidenceRow[] =>
  variants.map((variant) => baseRow(variant));



export const Useful: Story = {
  args: {
    citations: rows({
      forClaim: claim,
      forClaimRelation: 'support',
      state: 'loaded',
      opened: opened(),
    }),
  },
  render: (args) => <EvidenceFeature {...args} />,
};

export const Loading: Story = {
  args: {
    citations: rows({ state: 'loading' }),
    loading: true,
  },
  render: (args) => <EvidenceFeature {...args} />,
};

export const Empty: Story = {
  args: {
    citations: rows(),
  },
  render: (args) => <EvidenceFeature {...args} />,
};

export const Degraded: Story = {
  args: {
    citations: rows({
      outcome: {
        handle_ref: handle,
        outcome: 'VERIFY_UNAVAILABLE',
      },
      state: 'failed',
    }),
  },
  render: (args) => <EvidenceFeature {...args} />,
};

export const Error: Story = {
  args: {
    citations: [],
    errorMessage: 'Cited evidence could not be loaded for this section.',
  },
  render: (args) => <EvidenceFeature {...args} />,
};

export const LongRussian: Story = {
  args: {
    citations: rows({
      citation: reauthorized,
      forClaim: claim,
      forClaimRelation: 'support',
      state: 'loaded',
      opened: opened({ text: russianExcerpt }),
    }),
    longLocale: 'ru',
  },
  render: (args) => <EvidenceFeature {...args} />,
};


export const QuarantinedIsNotUnsupported: Story = {
  args: {
    citations: rows({
      outcome: { handle_ref: handle, outcome: 'SOURCE_QUARANTINED' },
      forClaim: claim,
      forClaimRelation: 'support',
      state: 'loaded',
    }),
  },
  render: (args) => <EvidenceFeature {...args} />,
};

export const RevokedSuppressesText: Story = {
  args: {
    citations: rows({
      outcome: { handle_ref: handle, outcome: 'AUTHORITY_REVOKED' },
      state: 'loaded',
      // Bytes exist in the fixture, but the revoked authority means they must not be rendered.
      opened: opened(),
    }),
  },
  render: (args) => <EvidenceFeature {...args} />,
};

export const StaleExcerptSuppressesText: Story = {
  args: {
    citations: rows({
      state: 'loaded',
      // The opened excerpt belongs to a different handle than the citation now offered.
      opened: opened({ handleRef: otherHandle, excerptSha256: 'a'.repeat(64) }),
    }),
  },
  render: (args) => <EvidenceFeature {...args} />,
};

export const CoordinateMismatchFailsClosed: Story = {
  args: {
    citations: rows({
      outcome: { handle_ref: handle, outcome: 'CONTENT_MISMATCH' },
      forClaim: {
        ...claim,
        disposition: 'UNSUPPORTED',
      },
      forClaimRelation: 'support',
      state: 'loaded',
      opened: opened(),
    }),
  },
  render: (args) => <EvidenceFeature {...args} />,
};


export const ResolutionNeverBecomesSupport: Story = {
  name: 'Negative: resolution never becomes support',
  args: {
    citations: rows({
      outcome: resolved,
      forClaim: claim,
      forClaimRelation: 'support',
      state: 'loaded',
      opened: opened(),
    }),
  },
  render: (args) => <EvidenceFeature {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The readback confirmation and the claim verdict are separate statements about different things.
    const readback = canvas.getByText('Citation read back for this session');
    await expect(readback).toBeVisible();

    const verdict = canvas.getByText('Supported');
    await expect(verdict).toBeVisible();

    // A confirmed readback must never carry or imply the support verdict.
    await expect(readback).not.toHaveTextContent('Supported');
    await expect(readback).not.toHaveTextContent('Unsupported');

    // The support verdict must never carry or imply that the citation bytes were confirmed.
    await expect(verdict).not.toHaveTextContent('Citation read back');
    await expect(verdict).not.toHaveTextContent('revoked');
    await expect(verdict).not.toHaveTextContent('quarantined');

    // The rail states the separation explicitly rather than leaving it implied.
    await expect(
      canvas.getByText('Readback confirmed. This still says nothing about whether the claim holds.'),
    ).toBeVisible();
  },
};

export const RevokedNeverRendersBytes: Story = {
  name: 'Negative: revoked authority never renders excerpt bytes',
  args: {
    citations: rows({
      outcome: { handle_ref: handle, outcome: 'AUTHORITY_REVOKED' },
      state: 'loaded',
      opened: opened(),
    }),
  },
  render: (args) => <EvidenceFeature {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The fixture carries renderable bytes. A revoked authority suppresses them entirely.
    await expect(canvas.getByText('Citation authority was revoked')).toBeVisible();
    await expect(
      canvas.queryByText('The saved scope of the report is frozen with its sources.'),
    ).toBeNull();

    // The note never converts the revocation into a claim verdict.
    await expect(
      canvas.getByText('This citation cannot be used. It is not evidence that the claim is unsupported.'),
    ).toBeVisible();
  },
};


export const OpenRequestsCurrentExcerpt: Story = {
  name: 'Negative: only an explicit request opens a current excerpt',
  args: {
    citations: rows({ state: 'idle' }),
  },
  render: (args) => <EvidenceFeature {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Nothing is opened on render. The rail opens no connection by itself.
    await expect(canvas.getByText('Excerpt not opened for this session.')).toBeVisible();
    await expect(canvas.queryByText("Opened handle excerpt-one:4")).toBeNull();

    const open = canvas.getByRole('button', { name: 'Open cited excerpt 1' });
    await expect(open).toBeEnabled();
    await userEvent.click(open);

    // After the callback the row keeps its own state, and the request is not silently retried.
    await expect(canvas.queryByRole('button', { name: 'Open cited excerpt 1' })).toBeNull();
  },
};

const announcementRows: readonly EvidenceRow[] = [
  baseRow({ state: 'loaded', opened: opened() }),
  baseRow({ citation: { handle_ref: otherHandle, excerpt_sha256: digest }, outcome: { handle_ref: otherHandle, outcome: 'SOURCE_QUARANTINED' }, state: 'idle' }),
  baseRow({ citation: { handle_ref: { id: 'failed-excerpt', revision: 1 }, excerpt_sha256: digest }, outcome: { handle_ref: { id: 'failed-excerpt', revision: 1 }, outcome: 'VERIFY_UNAVAILABLE' }, state: 'failed' }),
];
function EvidenceAnnouncementHarness() {
  const [message, setMessage] = useState('');
  const [phase, setPhase] = useState<'useful' | 'loading' | 'empty' | 'error'>('useful');
  return <>
    <button type="button" onClick={() => setMessage('The selected cited excerpt was verified.')}>Announce selected read</button>
    <button type="button" onClick={() => setPhase(old => old === 'useful' ? 'loading' : old === 'loading' ? 'empty' : old === 'empty' ? 'error' : 'useful')}>Change citation view</button>
    <div data-announced-evidence><EvidenceFeature citations={phase === 'empty' ? [] : announcementRows} loading={phase === 'loading'}
      {...(phase === 'error' ? { errorMessage: 'The citation list could not be read.' } : {})} operationAnnouncement={message} /></div>
    <div data-quiet-evidence hidden><EvidenceFeature citations={announcementRows} /></div>
  </>;
}
/** Explicit caller text owns one region; cached outcomes and row failures remain readable facts. */
export const EvidenceOperationAnnouncements: Story = {
  args: { citations: announcementRows, operationAnnouncement: '' },
  render: () => <EvidenceAnnouncementHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement), announced = canvasElement.querySelector<HTMLElement>('[data-announced-evidence]');
    const quiet = canvasElement.querySelector<HTMLElement>('[data-quiet-evidence]');
    if (!announced || !quiet) throw new TypeError('Evidence caller roots absent');
    const regions = (root: HTMLElement) => root.querySelectorAll('[role="status"], [role="alert"], [aria-live]');
    expect(regions(quiet)).toHaveLength(0);
    expect(regions(announced)).toHaveLength(1);
    const channel = announced.querySelector<HTMLElement>('.er-operation-announcement');
    if (!channel) throw new TypeError('Explicit Evidence operation channel absent');
    await expect(channel).toHaveAttribute('aria-live', 'polite');
    await expect(channel).toHaveAttribute('aria-atomic', 'true');
    await expect(channel).toHaveTextContent('');
    await userEvent.click(canvas.getByRole('button', { name: 'Announce selected read' }));
    await expect(channel).toHaveTextContent('The selected cited excerpt was verified.');
    for (let index = 0; index < 4; index++) {
      await userEvent.click(canvas.getByRole('button', { name: 'Change citation view' }));
      expect(announced.querySelector('.er-operation-announcement')).toBe(channel);
      expect(regions(announced)).toHaveLength(1);
      expect(regions(quiet)).toHaveLength(0);
      await expect(channel).toHaveTextContent('The selected cited excerpt was verified.');
    }
    expect(canvasElement.querySelectorAll('.evidence__outcome[role], .evidence__pending[role], .evidence__failed[role]')).toHaveLength(0);
  },
};
