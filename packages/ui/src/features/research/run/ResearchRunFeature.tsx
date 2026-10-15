import type {
  ResearchRunFailureView,
  ResearchRunStatusView,
  ResearchSessionProjection,
} from '@eliotr/owner-api-client';
import { useId, useState, type ReactNode } from 'react';
import { Button, Status } from '../../../primitives/primitives';
import { MaterialSymbol } from '../../../catalog/MaterialSymbol';
import './research-run.css';

/**
 * U4-R Research run feature: question first, then public execution progress.
 *
 * Props only. This component imports no client factory, fetch, query, agents socket or protocol
 * surface; the root owns remote reads, effect identities and the projection adapter. HTTP status and
 * history readback own detailed progress and failure reconciliation, while the projection snapshot is
 * an explicit refresh accelerator. Polling can never create or repeat a run: no callback in this file
 * builds a run body or mints an operation identity.
 *
 * Vocabulary the component keeps distinct:
 *   execution_state   ACTIVE, CANCELLED, ENGINE_COMPLETED
 *   engine_status     queued, running, paused, errored, terminated, complete, waiting, unknown
 *   dispatch_state    NOT_STARTED, OUTCOME_UNKNOWN, RESPONSE_RECEIVED
 *   recovery_action   NONE, READBACK, RECONCILE
 */

export type ResearchRunState = 'useful' | 'loading' | 'empty' | 'degraded' | 'error' | 'cancelled';

/** Projection of the accepted ResearchRunStatusView answer union. */
/**
 * The three accepted DTOs are carried directly. Nothing in this file restates a wire field,
 * enum or union: every label is derived from the real type by indexed access or Pick.
 */
export type ResearchRunProgress = ResearchRunStatusView;
export type ResearchRunFirstCause = ResearchRunFailureView;
export type ResearchRunSnapshot = ResearchSessionProjection;

export type ResearchRunPhase = NonNullable<ResearchRunFailureView['phase']>;
export type ResearchRunDispatchState = NonNullable<ResearchRunFailureView['dispatch_state']>;
export type ResearchRunReferencesIntact = NonNullable<ResearchRunFailureView['references_intact']>;
export type ResearchRunRecoveryAction = NonNullable<ResearchRunFailureView['recovery_action']>;

/** The only local shape: a display label for a scope reference. */
export interface ResearchRunScopeSelection {
  readonly id: string;
  readonly label: string;
}

export interface ResearchRunFeatureProps {
  readonly locale?: 'en' | 'ru';
  readonly state?: ResearchRunState;
  readonly question?: string;
  /** The viewed run remains held even when its current status read fails. */
  readonly questionHeld?: boolean;
  /** Optional parent-owned unsaved draft; keep its owner above an intent-key remount. */
  readonly draftQuestion?: string;
  /** Controlled drafts change only through this callback; value-only mode is read-only. */
  readonly onDraftQuestionChange?: (question: string) => void;
  /** Frozen labels when question is supplied; otherwise next-question selection labels. */
  readonly scope?: readonly ResearchRunScopeSelection[];
  readonly progress?: ResearchRunProgress;
  readonly firstCause?: ResearchRunFirstCause;
  /** An explicit snapshot refresh result. Never proactive streaming. */
  readonly snapshot?: ResearchSessionProjection;
  readonly canSubmit?: boolean;
  readonly busy?: boolean;
  /** Called with the trimmed question and the selection frozen at submit time. */
  readonly onAsk?: (question: string, frozenScope: readonly ResearchRunScopeSelection[]) => void;
  /** Called when the reviewer requests an explicit snapshot refresh. */
  readonly onRefreshSnapshot?: () => void;
  /** Called when the reviewer requests canonical HTTP status readback. */
  readonly onReadStatus?: () => void;
  /** Called to recover an unknown outcome. Never mints a new run. */
  readonly onRecover?: () => void;
  /**
   * Root-owned conversation items (run actions, recovery, history) placed after the run details
   * and before the composer, so the composer always closes the conversation. Presentation only.
   */
  readonly conversation?: ReactNode;
  /** Root-owned actions on this answer (open the report, ask another question), set inside Eliot's turn. */
  readonly answerActions?: ReactNode;
  /**
   * The open project, shown as the start cover's title (NotebookLM opens a notebook on its own
   * title and source count). Presentation only; without it the cover keeps its generic prompt.
   */
  readonly cover?: { readonly title: string; readonly meta?: string };
  /**
   * When set, asking with no ticked source asks the whole project; this label names that scope
   * ("All 3 sources") in the composer chip. Without it an empty selection stays "none selected".
   */
  readonly wholeScope?: string;
}

const ENGINE_LABEL: Record<'en' | 'ru', Record<ResearchRunStatusView['engine_status'], string>> = {
  en: { queued: 'Queued', running: 'Running', paused: 'Paused', errored: 'Failed', terminated: 'Stopped', complete: 'Finished', waiting: 'Waiting', waitingForPause: 'Pausing', unknown: 'Status unknown' },
  ru: { queued: 'В очереди', running: 'Выполняется', paused: 'Приостановлено', errored: 'Ошибка', terminated: 'Остановлено', complete: 'Завершено', waiting: 'Ожидание', waitingForPause: 'Приостанавливается', unknown: 'Состояние неизвестно' },
};
/** The owner's word for an engine status, shared by the run card and the recent research list. */
export function researchEngineLabel(locale: 'en' | 'ru', status: ResearchRunStatusView['engine_status']): string {
  return ENGINE_LABEL[locale][status];
}
const FAILURE_LABEL = {
  en: { code: 'Code', stage: 'Stage', phase: 'Phase', retryable: 'Can retry', dispatch: 'Request outcome', references: 'References', recovery: 'Recovery', yes: 'Yes', no: 'No' },
  ru: { code: 'Код', stage: 'Этап', phase: 'Фаза', retryable: 'Повтор возможен', dispatch: 'Результат запроса', references: 'Ссылки', recovery: 'Восстановление', yes: 'Да', no: 'Нет' },
} as const;

const SNAPSHOT_LABEL: Record<'en' | 'ru', Record<ResearchSessionProjection['state'], string>> = {
  en: {
    ACTIVE: 'A run is active',
    CANCELLED: 'The run was cancelled',
    ENGINE_COMPLETED: 'The engine finished',
  },
  ru: {
    ACTIVE: 'Запуск выполняется',
    CANCELLED: 'Запуск отменён',
    ENGINE_COMPLETED: 'Движок завершил работу',
  },
};

const PHASE_LABEL: Record<'en' | 'ru', Record<string, string>> = {
  en: {
    PREPARATION: 'preparation',
    STAGE: 'stage',
    RECOVERY: 'recovery',
  },
  ru: {
    PREPARATION: 'подготовка',
    STAGE: 'этап',
    RECOVERY: 'восстановление',
  },
};

const RECOVERY_LABEL: Record<'en' | 'ru', Record<ResearchRunRecoveryAction, string>> = {
  en: { NONE: 'No recovery action', READBACK: 'Read back the run', RECONCILE: 'Reconcile the run' },
  ru: { NONE: 'Восстановление не требуется', READBACK: 'Перечитать запуск', RECONCILE: 'Сверить запуск' },
};

const DISPATCH_LABEL: Record<'en' | 'ru', Record<ResearchRunDispatchState, string>> = {
  en: {
    NOT_STARTED: 'not started',
    OUTCOME_UNKNOWN: 'outcome unknown',
    RESPONSE_RECEIVED: 'response received',
  },
  ru: {
    NOT_STARTED: 'не начат',
    OUTCOME_UNKNOWN: 'результат неизвестен',
    RESPONSE_RECEIVED: 'ответ получен',
  },
};

const REFERENCES_LABEL: Record<'en' | 'ru', Record<ResearchRunReferencesIntact, string>> = {
  en: { INTACT: 'references intact', UNKNOWN: 'references unknown' },
  ru: { INTACT: 'ссылки не нарушены', UNKNOWN: 'состояние ссылок неизвестно' },
};
// Owner-facing words. The distinctions the engine keeps (finished is not accepted, cancelled is not
// finished, an unknown outcome is not a failure) stay in plain sentences, never in protocol terms.
const COPY: Record<'en' | 'ru', {
  lead: string;
  questionLabel: string;
  nextQuestionLabel: string;
  questionPlaceholder: string;
  questionHint: string;
  heldQuestionHint: string;
  currentQuestionLabel: string;
  currentScopeHeading: string;
  currentScopeEmpty: string;
  currentScopeCount: (count: number) => string;
  scopeHeading: string;
  scopeEmpty: string;
  scopeWhole: string;
  scopeCount: (count: number) => string;
  nextStage: (index: number) => string;
  completedStages: (index: number) => string;
  ask: string;
  details: string;
  generationLabel: string;
  asking: string;
  recordedQuestion: string;
  progressHeading: string;
  refreshSnapshot: string;
  readStatus: string;
  recover: string;
  snapshotHeading: string;
  snapshotNone: string;
  completedNotAccepted: string;
  answerUnavailable: string;
  answerDraft: string;
  cancelledHint: string;
  firstCauseHeading: string;
  consequenceHeading: string;
  outcomeUnknown: string;
  unknownReadbackForbidsNewIntent: string;
}> = {
  en: {
    lead: 'Ask anything about your sources.',
    questionLabel: 'Research question',
    nextQuestionLabel: 'Next question',
    questionPlaceholder: 'Ask about your sources',
    questionHint: 'Your question keeps the sources selected when you ask it.',
    heldQuestionHint: 'Your draft is kept. Send it when you are done with this research.',
    currentQuestionLabel: 'Your question',
    currentScopeHeading: 'Sources for this question',
    currentScopeEmpty: 'Source names are not shown for this question.',
    currentScopeCount: function (count: number) { return count === 1 ? '1 source' : count + ' sources'; },
    scopeHeading: 'Question sources',
    scopeEmpty: 'No source is selected yet. Choose sources first.',
    scopeWhole: 'The question uses every source in the project. Tick sources on the left to narrow it.',
    scopeCount: function (count: number) { return count === 1 ? '1 source selected' : count + ' sources selected'; },
    nextStage: function (index: number) { return 'Stage ' + (index + 1); },
    completedStages: function (index: number) { return index + ' stages completed'; },
    details: 'Details',
    generationLabel: 'System version',
    ask: 'Ask',
    asking: 'Asking',
    recordedQuestion: 'Your question',
    progressHeading: 'Progress',
    refreshSnapshot: 'Refresh snapshot',
    readStatus: 'Read status',
    recover: 'Recover this run',
    snapshotHeading: 'Snapshot',
    snapshotNone: 'No snapshot has been requested yet.',
    completedNotAccepted: 'This is a draft: it is not accepted or published yet.',
    answerUnavailable: 'No answer yet.',
    answerDraft: 'A draft answer is ready.',
    cancelledHint: 'A cancelled run is not finished.',
    firstCauseHeading: 'What went wrong',
    consequenceHeading: 'What followed',
    outcomeUnknown: 'The outcome of this run is not yet known.',
    unknownReadbackForbidsNewIntent: 'Check this research before asking anything new.',
  },
  ru: {
    lead: 'Спросите что угодно по вашим источникам.',
    questionLabel: 'Вопрос исследования',
    nextQuestionLabel: 'Следующий вопрос',
    questionPlaceholder: 'Спросите по вашим источникам',
    questionHint: 'Вопрос сохранит источники, выбранные на момент отправки.',
    heldQuestionHint: 'Черновик сохранится. Отправьте его, когда закончите с этим исследованием.',
    currentQuestionLabel: 'Ваш вопрос',
    currentScopeHeading: 'Источники этого вопроса',
    currentScopeEmpty: 'Названия источников этого вопроса здесь не показаны.',
    currentScopeCount: function (count: number) { const tail = count % 10, hundred = count % 100; return count + ' ' + (tail === 1 && hundred !== 11 ? 'источник' : tail >= 2 && tail <= 4 && (hundred < 12 || hundred > 14) ? 'источника' : 'источников'); },
    scopeHeading: 'Источники вопроса',
    scopeEmpty: 'Источники ещё не выбраны. Сначала выберите их.',
    scopeWhole: 'Вопрос использует все источники проекта. Отметьте источники слева, чтобы сузить его.',
    scopeCount: function (count: number) { return 'Выбрано: ' + count; },
    nextStage: function (index: number) { return 'Этап ' + (index + 1); },
    completedStages: function (index: number) { return 'Завершено этапов: ' + index; },
    details: 'Подробности',
    generationLabel: 'Версия системы',
    ask: 'Спросить',
    asking: 'Отправка',
    recordedQuestion: 'Ваш вопрос',
    progressHeading: 'Ход работы',
    refreshSnapshot: 'Обновить снимок',
    readStatus: 'Проверить статус',
    recover: 'Восстановить исследование',
    snapshotHeading: 'Снимок',
    snapshotNone: 'Снимок ещё не запрашивался.',
    completedNotAccepted: 'Это черновик: он ещё не принят и не опубликован.',
    answerUnavailable: 'Ответа пока нет.',
    answerDraft: 'Черновик ответа готов.',
    cancelledHint: 'Отмена — это не завершение.',
    firstCauseHeading: 'Что пошло не так',
    consequenceHeading: 'Что последовало',
    outcomeUnknown: 'Результат этого исследования пока неизвестен.',
    unknownReadbackForbidsNewIntent: 'Проверьте это исследование, прежде чем задавать новый вопрос.',
  },
};
const STATE_NOTICE: Record<'en' | 'ru', Record<ResearchRunState, string>> = {
  en: {
    useful: 'Research finished.',
    loading: 'Researching your sources…',
    empty: 'No research yet. Ask a question to begin.',
    degraded: 'Progress is unknown right now. Check the status again.',
    error: 'The research stopped. Check the status to see what is known.',
    cancelled: 'The research was cancelled.',
  },
  ru: {
    useful: 'Исследование завершено.',
    loading: 'Исследую источники…',
    empty: 'Исследований ещё нет. Задайте вопрос, чтобы начать.',
    degraded: 'Ход работы сейчас неизвестен. Проверьте статус ещё раз.',
    error: 'Исследование остановилось. Проверьте статус, чтобы узнать подробности.',
    cancelled: 'Исследование отменено.',
  },
};

export function ResearchRunFeature({
  locale = 'en',
  state = 'empty',
  question,
  questionHeld = false,
  draftQuestion,
  onDraftQuestionChange,
  scope,
  progress,
  firstCause,
  snapshot,
  canSubmit = false,
  busy = false,
  onAsk,
  onRefreshSnapshot,
  onReadStatus,
  onRecover,
  conversation,
  answerActions,
  cover,
  wholeScope,
}: ResearchRunFeatureProps) {
  const [localDraft, setLocalDraft] = useState<string>('');
  const [recorded, setRecorded] = useState<string | null>(question ?? null);
  const controlledDraft = draftQuestion !== undefined;
  const draft = draftQuestion ?? localDraft;
  const recordedQuestion = controlledDraft ? question ?? null : recorded;
  const headingId = useId();
  const questionId = headingId + '-question';
  const copy = COPY[locale];
  const notice = STATE_NOTICE[locale][state];
  const selected = scope ?? [];
  const frozen = selected.slice();
  const unknownOutcome = firstCause !== undefined && firstCause.dispatch_state === 'OUTCOME_UNKNOWN';
  const hasQuestion = questionHeld || question !== undefined || progress !== undefined || firstCause !== undefined
    || (controlledDraft && snapshot !== undefined);
  const draftHeld = hasQuestion || busy;
  const controlledWithoutAsk = controlledDraft && onAsk === undefined;

  function submit() {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || busy || !canSubmit || hasQuestion || controlledWithoutAsk) return;
    if (!controlledDraft) {
      setRecorded(trimmed);
      setLocalDraft('');
    }
    if (onAsk !== undefined) onAsk(trimmed, frozen);
  }

  const scopeDisclosure = (
    <details className="er-research-run__scope">
      <summary><h3 className="er-research-run__scope-heading">{controlledDraft && question !== undefined ? copy.currentScopeHeading : copy.scopeHeading}</h3>
        <span className="er-research-run__scope-count">{controlledDraft && question !== undefined ? copy.currentScopeCount(selected.length)
          : selected.length === 0 && wholeScope !== undefined ? wholeScope : copy.scopeCount(selected.length)}</span></summary>
      {selected.length === 0 ? (
        <p className="er-research-run__scope-empty">{controlledDraft && question !== undefined ? copy.currentScopeEmpty
          : wholeScope !== undefined ? copy.scopeWhole : copy.scopeEmpty}</p>
      ) : (
        <ul className="er-research-run__scope-list">
          {selected.map(function (item) {
            return <li className="er-research-run__scope-item" key={item.id}>{item.label}</li>;
          })}
        </ul>
      )}
    </details>
  );
  const runActions = (
    <div className="er-research-run__actions">
      {!hasQuestion && <Button
        variant="primary"
        icon="arrow-up"
        loading={busy}
        disabled={busy || canSubmit === false || draft.trim().length === 0 || controlledWithoutAsk}
        onClick={submit}
      >
        {busy ? copy.asking : copy.ask}
      </Button>}
      {onReadStatus === undefined ? null : (
        <Button variant="text" disabled={busy} onClick={onReadStatus}>{copy.readStatus}</Button>
      )}
      {onRefreshSnapshot === undefined ? null : (
        <Button variant="text" disabled={busy} onClick={onRefreshSnapshot}>{copy.refreshSnapshot}</Button>
      )}
    </div>
  );

  // The composer closes the conversation: one field surface holds the question, the scope chip
  // and the Ask action; hints sit beneath the surface like NotebookLM's disclaimer line.
  const questionEditor = (
    <div className="er-research-run__dock">
      <div className="er-research-run__composer" data-held={hasQuestion ? 'true' : 'false'}>
        {(controlledDraft || !hasQuestion) && <div className="er-research-run__question">
          <label htmlFor={questionId}>{controlledDraft && draftHeld ? copy.nextQuestionLabel : copy.questionLabel}</label>
          <textarea className="er-research-run__question-input"
          id={questionId}
          aria-describedby={questionId + '-hint'} rows={1}
          placeholder={copy.questionPlaceholder}
          value={draft}
          disabled={!controlledDraft && busy}
          readOnly={controlledDraft && onDraftQuestionChange === undefined}
          onChange={function (event: React.ChangeEvent<HTMLTextAreaElement>) {
            const value = event.currentTarget.value;
            if (!controlledDraft) setLocalDraft(value);
            onDraftQuestionChange?.(value);
          }}
          />
        </div>}
        {!hasQuestion ? <div className="er-research-run__composer-bar">{scopeDisclosure}{runActions}</div> : null}
      </div>
      <div className="er-research-run__hints">
        <p id={questionId + '-hint'} className="er-research-run__question-hint">{controlledDraft && draftHeld ? copy.heldQuestionHint : copy.questionHint}</p>
      </div>
    </div>
  );

  // What stopped the run, or why its outcome is unknown: inside Eliot's turn once a question exists.
  const outcome = (
    <>
      {unknownOutcome ? (
        <section className="er-research-run__unknown">
          <Status tone="error">{copy.outcomeUnknown}</Status>
          <p className="er-research-run__unknown-note">{copy.unknownReadbackForbidsNewIntent}</p>
          {onRecover === undefined ? null : (
            <Button variant="tonal" disabled={busy} onClick={onRecover}>{copy.recover}</Button>
          )}
        </section>
      ) : null}

      {firstCause === undefined ? null : (
        <section className="er-research-run__failure">
          <h3 className="er-research-run__failure-heading">{copy.firstCauseHeading}</h3>
          <p className="er-research-run__failure-summary">{firstCause.stage === undefined ? null : <>{firstCause.stage} · </>}<code>{firstCause.code}</code></p>
          <details><summary>{copy.details}</summary>
          <dl className="er-research-run__failure-list">
            <dt>{FAILURE_LABEL[locale].code}</dt>
            <dd>{firstCause.code}</dd>
            {firstCause.stage === undefined ? null : (
              <>
                <dt>{FAILURE_LABEL[locale].stage}</dt>
                <dd>{firstCause.stage}</dd>
              </>
            )}
            {firstCause.phase === undefined ? null : (
              <>
                <dt>{FAILURE_LABEL[locale].phase}</dt>
                <dd>{PHASE_LABEL[locale][firstCause.phase]}</dd>
              </>
            )}
            {firstCause.retryable === undefined ? null : (
              <><dt>{FAILURE_LABEL[locale].retryable}</dt><dd>{firstCause.retryable ? FAILURE_LABEL[locale].yes : FAILURE_LABEL[locale].no}</dd></>
            )}
            {firstCause.dispatch_state === undefined ? null : (
              <><dt>{FAILURE_LABEL[locale].dispatch}</dt><dd>{DISPATCH_LABEL[locale][firstCause.dispatch_state]}</dd></>
            )}
            {firstCause.references_intact === undefined ? null : (
              <><dt>{FAILURE_LABEL[locale].references}</dt><dd>{REFERENCES_LABEL[locale][firstCause.references_intact]}</dd></>
            )}
            {firstCause.recovery_action === undefined ? null : (
              <><dt>{FAILURE_LABEL[locale].recovery}</dt><dd>{RECOVERY_LABEL[locale][firstCause.recovery_action]}</dd></>
            )}
          </dl>
          {(firstCause.consequences?.length ?? 0) === 0 ? null : (
            <>
              <h4 className="er-research-run__consequence-heading">{copy.consequenceHeading}</h4>
              <ul className="er-research-run__consequence-list">
                {(firstCause.consequences ?? []).map(function (item, index) {
                  return <li className="er-research-run__consequence-item" key={index}>{item.code}</li>;
                })}
              </ul>
            </>
          )}
          </details>
        </section>
      )}
    </>
  );

  return (
    <section className="er-research-run" aria-labelledby={headingId} data-phase={hasQuestion ? 'conversation' : 'start'}>
      <header className="er-research-run__intro">{!hasQuestion ? <span className="er-research-run__cover-icon"><MaterialSymbol name="spark" /></span> : null}<h2 className="er-research-run__heading" id={headingId}>{hasQuestion ? (locale === 'ru' ? 'Ваше исследование' : 'Your research') : cover?.title ?? (locale === 'ru' ? 'Спросите свои источники' : 'Ask your sources')}</h2>
      {!hasQuestion && cover?.meta ? <p className="er-research-run__meta">{cover.meta}</p> : null}
      {!hasQuestion ? <p className="er-research-run__lead">{copy.lead}</p> : null}</header>

      {recordedQuestion === null ? null : (
        <p className="er-research-run__recorded">
          <span className="er-research-run__recorded-label">{controlledDraft && hasQuestion ? copy.currentQuestionLabel : copy.recordedQuestion}</span>
          <span className="er-research-run__recorded-value">{recordedQuestion}</span>
        </p>
      )}

      {/* The start cover already invites the first question; the empty notice would only repeat it. */}
      {!hasQuestion && state !== 'empty' ? <Status tone={state === 'error' ? 'error' : 'neutral'}>{notice}</Status> : null}

      {/* Eliot's turn, as NotebookLM answers in the chat: one card with the run's state, its
          progress, what exists and the sources the question froze. Technical facts stay in Details. */}
      {hasQuestion ? <div className="er-research-run__turn" data-state={state}>
        <span className="er-research-run__turn-avatar" aria-hidden="true"><MaterialSymbol name="spark" /></span>
        <div className="er-research-run__turn-body">
          <Status tone={state === 'error' ? 'error' : 'neutral'}>{notice}</Status>
          {progress === undefined ? null : (
            <section className="er-research-run__progress" aria-label={copy.progressHeading}>
              {/* While the engine works its stage leads; once it is done the notice says so and the
                  stage count moves into Details. */}
              {progress.execution_state === 'ENGINE_COMPLETED' ? null : <p className="er-research-run__stage">
                {copy.nextStage(progress.next_stage_index)} · {ENGINE_LABEL[locale][progress.engine_status]}
              </p>}
              {progress.execution_state === 'ACTIVE' && state === 'loading'
                ? <span className="er-research-run__meter" aria-hidden="true"><span /></span> : null}
              <p className="er-research-run__answer" data-available={progress.answer.availability === 'unavailable' ? 'false' : 'true'}>
                {progress.answer.availability === 'unavailable' ? copy.answerUnavailable : copy.answerDraft}
              </p>
              {progress.execution_state === 'ENGINE_COMPLETED' ? (
                <p className="er-research-run__caution">{copy.completedNotAccepted}</p>
              ) : null}
              {progress.execution_state === 'CANCELLED' ? (
                <p className="er-research-run__caution">{copy.cancelledHint}</p>
              ) : null}
              <details className="er-research-run__more">
                <summary>{copy.details}</summary>
                {progress.execution_state === 'ENGINE_COMPLETED' ? <p className="er-research-run__stage">
                  {copy.completedStages(progress.next_stage_index)} · {ENGINE_LABEL[locale][progress.engine_status]}
                </p> : null}
                <dl className="er-research-run__details">
                  <dt>{copy.generationLabel}</dt>
                  <dd>{progress.deployment_generation}</dd>
                </dl>
              </details>
            </section>
          )}
          {outcome}
          <div className="er-research-run__current-controls">{scopeDisclosure}{runActions}</div>
          {answerActions}
        </div>
      </div> : null}

      {(snapshot !== undefined || onRefreshSnapshot !== undefined) && <section className="er-research-run__snapshot">
        <h3 className="er-research-run__snapshot-heading">{copy.snapshotHeading}</h3>
        {snapshot === undefined ? (
          <p className="er-research-run__snapshot-none">{copy.snapshotNone}</p>
        ) : (
          <p className="er-research-run__snapshot-state">{SNAPSHOT_LABEL[locale][snapshot.state]}</p>
        )}
      </section>}

      {hasQuestion ? null : outcome}
      {conversation}
      {!hasQuestion || controlledDraft ? questionEditor : null}
    </section>
  );
}
