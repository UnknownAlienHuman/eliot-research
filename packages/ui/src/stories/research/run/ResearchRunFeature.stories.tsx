import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import {
  ResearchRunFeature,
  type ResearchRunFeatureProps,
  type ResearchRunFirstCause,
  type ResearchRunProgress,
  type ResearchRunScopeSelection,
  type ResearchRunSnapshot,
} from '../../../features/research/run/ResearchRunFeature';

const meta: Meta<ResearchRunFeatureProps> = {
  title: 'Product/Research/Run',
  component: ResearchRunFeature,
  args: { state: 'empty' },
  decorators: [(Story) => <div className="eliot-token-story"><Story /></div>],
};
export default meta;
type Story = StoryObj<typeof meta>;

const SCOPE: readonly ResearchRunScopeSelection[] = [
  { id: 'src-1', label: 'Systems of record, first revision' },
  { id: 'src-2', label: 'Field notes on evidence handling' },
];

const PROGRESS_ACTIVE: ResearchRunProgress = {
  workflow_instance_id: 'run-1',
  investigation_ref: { id: 'investigation-1', revision: 1 },
  execution_state: 'ACTIVE',
  engine_status: 'running',
  next_stage_index: 6,
  answer: { availability: 'unavailable' },
  deployment_generation: 'run-fixture',
};

const PROGRESS_COMPLETED: ResearchRunProgress = {
  workflow_instance_id: 'run-2',
  investigation_ref: { id: 'investigation-2', revision: 1 },
  execution_state: 'ENGINE_COMPLETED',
  engine_status: 'complete',
  next_stage_index: 18,
  answer: { availability: 'draft', artifact_ref: { id: 'artifact-2', revision: 1 } },
  deployment_generation: 'run-fixture',
};

const FIRST_CAUSE: ResearchRunFirstCause = {
  code: 'WORKFLOW_OUTPUT_UNAVAILABLE',
  stage: 'READ_AND_EXTRACT',
  phase: 'STAGE',
  retryable: false,
  dispatch_state: 'RESPONSE_RECEIVED',
  references_intact: 'INTACT',
  recovery_action: 'READBACK',
  consequences: [{ code: 'WORKFLOW_STORAGE_UNAVAILABLE' }],
};

const FIRST_CAUSE_UNKNOWN: ResearchRunFirstCause = {
  code: 'WORKFLOW_EFFECT_UNCERTAIN',
  retryable: false,
  dispatch_state: 'OUTCOME_UNKNOWN',
  references_intact: 'UNKNOWN',
  recovery_action: 'RECONCILE',
  consequences: [],
};
const SNAPSHOT_ACTIVE: ResearchRunSnapshot = {
  protocol: 'eliotr.research-session-projection.v1', session_id: 'session-fixture', operation_id: 'operation-fixture',
  state: 'ACTIVE', investigation_ref: PROGRESS_ACTIVE.investigation_ref,
  run_status: { execution_state: 'ACTIVE', engine_status: 'running', next_stage_index: 6 },
};
const SNAPSHOT_COMPLETED: ResearchRunSnapshot = {
  protocol: 'eliotr.research-session-projection.v1', session_id: 'session-fixture', operation_id: 'operation-fixture',
  state: 'ENGINE_COMPLETED', investigation_ref: PROGRESS_COMPLETED.investigation_ref,
  completion_receipt_ref: 'completion-fixture', output_manifest_ref: 'output-manifest-fixture',
};
const SNAPSHOT_CANCELLED: ResearchRunSnapshot = {
  protocol: 'eliotr.research-session-projection.v1', session_id: 'session-fixture', operation_id: 'operation-fixture',
  state: 'CANCELLED', investigation_ref: PROGRESS_ACTIVE.investigation_ref, cancellation_receipt_ref: 'cancellation-fixture',
};

export const Useful: Story = {
  args: { state: 'useful', scope: SCOPE, progress: PROGRESS_COMPLETED, snapshot: SNAPSHOT_COMPLETED },
};

export const Loading: Story = {
  args: { state: 'loading', scope: SCOPE, progress: PROGRESS_ACTIVE, snapshot: SNAPSHOT_ACTIVE, busy: true },
};

export const Empty: Story = { args: { state: 'empty' } };

export const Degraded: Story = {
  args: {
    state: 'degraded',
    scope: SCOPE,
    firstCause: FIRST_CAUSE_UNKNOWN,
    onReadStatus: () => {},
    onRecover: () => {},
  },
};

export const Error: Story = {
  args: { state: 'error', scope: SCOPE, firstCause: FIRST_CAUSE, onReadStatus: () => {}, onRecover: () => {} },
};

export const Cancelled: Story = {
  args: { state: 'cancelled', scope: SCOPE, snapshot: SNAPSHOT_CANCELLED },
};

export const LongRussian: Story = {
  args: {
    locale: 'ru',
    state: 'loading',
    scope: [{ id: 'src-1', label: 'Системы учёта, первая редакция с длинным названием проекта' }],
    progress: PROGRESS_ACTIVE,
    snapshot: SNAPSHOT_ACTIVE,
    canSubmit: true,
  },
};
/**
 * Polling and refresh can never create or repeat a run. The journey proves that the only actions
 * available are read-only status readback and an explicit snapshot refresh, and that neither an
 * unknown outcome nor any other state produces a new run intent.
 */
export const ReadbackCannotStartARun: Story = {
  args: {
    state: 'degraded',
    scope: SCOPE,
    firstCause: FIRST_CAUSE_UNKNOWN,
    onReadStatus: () => {},
    onRefreshSnapshot: () => {},
    onRecover: () => {},
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    expect(canvas.getByText('The outcome of this run is not yet known.')).toBeInTheDocument();
    expect(canvas.getByText(/Read back the run before starting anything new/)).toBeInTheDocument();
    expect(canvas.getByRole('button', { name: 'Read status' })).toBeInTheDocument();
    expect(canvas.getByRole('button', { name: 'Refresh snapshot' })).toBeInTheDocument();

    await userEvent.click(canvas.getByRole('button', { name: 'Refresh snapshot' }));
    expect(canvas.getByText('The outcome of this run is not yet known.')).toBeInTheDocument();
  },
};

/** ENGINE_COMPLETED is never presented as report acceptance or publication. */
export const CompletionIsNotAcceptance: Story = {
  args: { state: 'useful', scope: SCOPE, progress: PROGRESS_COMPLETED, snapshot: SNAPSHOT_COMPLETED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText('Engine completion is not report acceptance or publication.')).toBeInTheDocument();
    expect(canvas.getByText('18 stages completed · complete')).toBeInTheDocument();
    expect(canvas.queryByText(/Next stage 19|Stage 19/u)).not.toBeInTheDocument();
  },
};

/** Controlled next-question drafts are local text while a run is held. */
const CONTROLLED_CURRENT_QUESTION = 'Which claims are supported by the selected sources?';

function ControlledNextQuestionDraftAdapter(props: ResearchRunFeatureProps) {
  const [draftQuestion, setDraftQuestion] = useState('');
  return <ResearchRunFeature
    {...props}
    draftQuestion={draftQuestion}
    onDraftQuestionChange={setDraftQuestion}
  />;
}

/** One catalog story: independent EN/RU local drafts while the same run is held. */
export const ControlledNextQuestionDraft: Story = {
  args: {
    state: 'loading',
    busy: true,
    canSubmit: true,
    question: CONTROLLED_CURRENT_QUESTION,
    scope: SCOPE,
    progress: PROGRESS_ACTIVE,
  },
  render: args => <>
    <ControlledNextQuestionDraftAdapter {...args} locale="en" />
    <ControlledNextQuestionDraftAdapter {...args} locale="ru" />
  </>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const englishDraft = canvas.getByRole('textbox', { name: 'Next question draft (unsent)' });
    const russianDraft = canvas.getByRole('textbox', { name: 'Черновик следующего вопроса (не отправлен)' });
    const englishText = 'Compare the evidence before the next question.';
    const russianText = 'Сравните источники и укажите ограничения для следующего вопроса.';

    expect(englishDraft).toBeEnabled();
    expect(russianDraft).toBeEnabled();
    expect(englishDraft).toHaveValue('');
    expect(russianDraft).toHaveValue('');
    expect(canvas.getAllByText(CONTROLLED_CURRENT_QUESTION)).toHaveLength(2);
    // No other action callbacks are supplied: absence of every button also
    // rules out a busy-labelled Ask control in either locale.
    expect(canvas.queryAllByRole('button')).toHaveLength(0);

    await userEvent.type(englishDraft, englishText);
    expect(englishDraft).toHaveValue(englishText);
    expect(russianDraft).toHaveValue('');
    await userEvent.type(russianDraft, russianText);
    expect(russianDraft).toHaveValue(russianText);
    expect(englishDraft).toHaveValue(englishText);

    expect(canvas.getAllByText(CONTROLLED_CURRENT_QUESTION)).toHaveLength(2);
    for (const source of SCOPE) {
      expect(canvas.getAllByText(source.label)).toHaveLength(2);
    }
    expect(canvas.queryAllByRole('button')).toHaveLength(0);
  },
};

export const OptionalFailureFacts: Story = {
  render: () => <><ResearchRunFeature locale="en" state="error" firstCause={{ code: 'WORKFLOW_OUTPUT_UNAVAILABLE' }} />
    <ResearchRunFeature locale="ru" state="error" firstCause={FIRST_CAUSE} progress={{ ...PROGRESS_ACTIVE, engine_status: 'waitingForPause' }} /></>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const list of canvasElement.querySelectorAll('.er-research-run__failure-list')) {
      const children = [...list.children];
      expect(children.length % 2).toBe(0);
      children.forEach((child, i) => expect(child.tagName).toBe(i % 2 === 0 ? 'DT' : 'DD'));
    }
    expect(canvas.getByText(/Приостанавливается/u)).toBeVisible();
    expect(canvas.queryByText(/waitingForPause/u)).not.toBeInTheDocument();
    const failures = canvasElement.querySelectorAll('.er-research-run__failure');
    if (!failures[0] || !failures[1]) throw new globalThis.Error('Both failure cases must render');
    expect(failures[0]).not.toHaveTextContent('Can retry');
    await userEvent.click(within(failures[1] as HTMLElement).getByText('Подробности'));
    expect(canvas.getByText('Нет', { exact: true })).toBeVisible();
    expect(canvasElement.querySelectorAll('[role="status"], [aria-live]')).toHaveLength(0);
  },
};
