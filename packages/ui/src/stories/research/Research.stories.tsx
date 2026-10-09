import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ResearchFixture } from '../../patterns/research/fixtures/ResearchFixture';

const meta = {
  title: 'Product/Research',
  component: ResearchFixture,
} satisfies Meta<typeof ResearchFixture>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Useful: Story = {
  args: { state: 'complete', scopeCount: 3, snapshot: 'engine-completed' },
  render: (args) => <ResearchFixture {...args} />,
};

export const Loading: Story = {
  args: { state: 'loading', scopeCount: 3, budget: 'scan' },
  render: (args) => <ResearchFixture {...args} />,
};

export const Empty: Story = {
  args: { state: 'empty', scopeCount: 0 },
  render: (args) => <ResearchFixture {...args} />,
};

export const Degraded: Story = {
  args: { state: 'degraded', scopeCount: 3, noHits: true },
  render: (args) => <ResearchFixture {...args} />,
};

export const Error: Story = {
  args: { state: 'error', scopeCount: 3, budget: 'context' },
  render: (args) => <ResearchFixture {...args} />,
};

export const LongRussian: Story = {
  args: {
    state: 'complete',
    locale: 'ru',
    scopeCount: 5,
    budget: 'evidence',
    snapshot: 'active',
  },
  render: (args) => <ResearchFixture {...args} />,
};

export const OutcomeUnknown: Story = { args: { state: 'empty', scopeCount: 3, outcomeUnknown: true } };
export const CandidateLimit: Story = { args: { state: 'complete', scopeCount: 3, budget: 'candidate' } };
export const ScanLimit: Story = { args: { state: 'complete', scopeCount: 3, budget: 'scan' } };
export const EvidenceLimit: Story = { args: { state: 'complete', scopeCount: 3, budget: 'evidence' } };
export const ContextLimit: Story = { args: { state: 'complete', scopeCount: 3, budget: 'context' } };

export const InteractionJourney: Story = {
  args: { state: 'empty', scopeCount: 3 },
  render: (args) => <ResearchFixture {...args} />,
  play: async ({ canvasElement }) => {
    // Submit first: reading a sample report must not turn a pending request into completion.
    const canvas = within(canvasElement);

    const ask = canvas.getByRole('button', { name: /ask/i });
    await expect(ask).toBeDisabled();

    const field = canvas.getByRole('textbox', { name: /research question/i });
    await userEvent.type(field, 'What changed?');
    await expect(ask).toBeEnabled();
    await userEvent.click(ask);
    await expect(ask).toBeDisabled();
    await expect(canvas.getByText('Sample question recorded. This preview does not generate answers. Open the sample report to explore its citations.')).toBeVisible();
    await expect(canvas.getByText('What changed?', { exact: false }).closest('p')).toHaveTextContent('3 sources in scope');

    // The report toggle is available in every state, including loading.
    const reportToggle = canvas.getByRole('button', { name: /show sample report/i });
    await expect(reportToggle).toBeVisible();

    // Opening the sample report is independent of the pending request.
    await userEvent.click(reportToggle);
    await expect(canvas.getByRole('article')).toBeVisible();
    await expect(canvas.getByRole('button', { name: /hide sample report/i })).toBeVisible();
    await expect(ask).toBeDisabled();

    // The citation action resolves locally to the accepted Dialog.
    const cite = canvas.getByRole('button', { name: /view citation/i });
    await userEvent.click(cite);
    await expect(canvas.getByRole('dialog', { name: /citation detail/i })).toBeVisible();
    canvas.getByRole('dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(canvas.queryByRole('dialog')).not.toBeInTheDocument());
  },
};

