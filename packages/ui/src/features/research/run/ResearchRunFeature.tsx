import type {
  ResearchRunFailureView,
  ResearchRunStatusView,
  ResearchSessionProjection,
} from '@eliotr/owner-api-client';
import { useId, useState } from 'react';
import { Button, Field, Status } from '../../../primitives/primitives';
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
}

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
const COPY: Record<'en' | 'ru', {
  heading: string;
  lead: string;
  questionLabel: string;
  questionPlaceholder: string;
  questionHint: string;
  scopeHeading: string;
  scopeEmpty: string;
  scopeCount: (count: number) => string;
  nextStage: (index: number) => string;
  completedStages: (index: number) => string;
  ask: string;
  details: string;
  generationLabel: string;
  asking: string;
  recordedQuestion: string;
  progressHeading: string;
  stagePrefix: string;
  observedPrefix: string;
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
  degraded: string;
  error: string;
    empty: string;
    loading: string;
    useful: string;
}> = {
  en: {
    heading: 'Research run',
    lead: 'Ask a question with the sources you choose.',
    questionLabel: 'Research question',
    questionPlaceholder: 'What does my selected scope support?',
    questionHint: 'The question is frozen when you ask it.',
    scopeHeading: 'Selected scope',
    scopeEmpty: 'No source is selected. Pick sources in Sources first.',
    scopeCount: function (count: number) { return count === 1 ? '1 source selected' : count + ' sources selected'; },
    nextStage: function (index: number) { return 'Next stage ' + (index + 1); },
    completedStages: function (index: number) { return index + ' stages completed'; },
    details: 'Details',
    generationLabel: 'Deployment generation',
    ask: 'Ask',
    asking: 'Asking',
    recordedQuestion: 'Recorded question',
    progressHeading: 'Execution progress',
    stagePrefix: 'Stage',
    observedPrefix: 'Last observed',
    refreshSnapshot: 'Refresh snapshot',
    readStatus: 'Read status',
    recover: 'Recover this run',
    snapshotHeading: 'Snapshot, explicit refresh only',
    snapshotNone: 'No snapshot has been requested yet.',
    completedNotAccepted: 'Engine completion is not report acceptance or publication.',
    answerUnavailable: 'No answer is available yet.',
    answerDraft: 'A draft answer exists.',
    cancelledHint: 'Cancellation is not completion.',
    firstCauseHeading: 'First failure cause',
    consequenceHeading: 'Later consequences',
    outcomeUnknown: 'The outcome of this run is not yet known.',
    unknownReadbackForbidsNewIntent: 'Read back the run before starting anything new. A new intent is not offered.',
    degraded: 'Progress is unavailable until a fresh status readback succeeds.',
    error: 'This run could not continue. Read back the run for what is known.',
    empty: 'No run yet. Ask a question to begin.',
    loading: 'The run is in progress. Progress comes from status readback.',
    useful: 'The run finished. Review the draft answer.',
  },
  ru: {
    heading: 'Запуск исследования',
    lead: 'Задайте вопрос по выбранным источникам.',
    questionLabel: 'Вопрос исследования',
    questionPlaceholder: 'Что подтверждает выбранная область?',
    questionHint: 'Вопрос фиксируется в момент отправки.',
    scopeHeading: 'Выбранная область',
    scopeEmpty: 'Источник не выбран. Сначала выберите источники в разделе «Источники».',
    scopeCount: function (count: number) { return 'Выбрано источников: ' + count; },
    nextStage: function (index: number) { return 'Следующий этап ' + (index + 1); },
    completedStages: function (index: number) { return 'Завершено этапов: ' + index; },
    details: 'Подробности',
    generationLabel: 'Поколение развёртывания',
    ask: 'Спросить',
    asking: 'Отправка',
    recordedQuestion: 'Записанный вопрос',
    progressHeading: 'Ход выполнения',
    stagePrefix: 'Этап',
    observedPrefix: 'Последнее наблюдение',
    refreshSnapshot: 'Обновить снимок',
    readStatus: 'Прочитать статус',
    recover: 'Восстановить этот запуск',
    snapshotHeading: 'Снимок только по явному обновлению',
    snapshotNone: 'Снимок ещё не запрашивался.',
    completedNotAccepted: 'Завершение движка не является принятием или публикацией отчёта.',
    answerUnavailable: 'Ответ пока недоступен.',
    answerDraft: 'Доступен черновик ответа.',
    cancelledHint: 'Отмена не является завершением.',
    firstCauseHeading: 'Первая причина сбоя',
    consequenceHeading: 'Последующие следствия',
    outcomeUnknown: 'Результат этого запуска ещё не известен.',
    unknownReadbackForbidsNewIntent: 'Перечитайте запуск прежде чем начинать что-либо новое. Новое намерение не предлагается.',
    degraded: 'Ход выполнения недоступен, пока не удастся выполнить свежее чтение статуса.',
    error: 'Этот запуск не может продолжаться. Перечитайте запуск, чтобы узнать известное.',
    empty: 'Запусков ещё нет. Задайте вопрос, чтобы начать.',
    loading: 'Запуск выполняется. Ход выполнения поступает из чтения статуса.',
    useful: 'Запуск завершён. Ознакомьтесь с черновиком ответа.',
  },
};
const STATE_NOTICE: Record<'en' | 'ru', Record<ResearchRunState, string>> = {
  en: {
    useful: 'The run finished. Review the draft answer.',
    loading: 'The run is in progress. Progress comes from status readback.',
    empty: 'No run yet. Ask a question to begin.',
    degraded: 'Progress is unavailable until a fresh status readback succeeds.',
    error: 'This run could not continue. Read back the run for what is known.',
    cancelled: 'This run was cancelled. Cancellation is not completion.',
  },
  ru: {
    useful: 'Запуск завершён. Ознакомьтесь с черновиком ответа.',
    loading: 'Запуск выполняется. Ход выполнения поступает из чтения статуса.',
    empty: 'Запусков ещё нет. Задайте вопрос, чтобы начать.',
    degraded: 'Ход выполнения недоступен, пока не удастся выполнить свежее чтение статуса.',
    error: 'Этот запуск не может продолжаться. Перечитайте запуск, чтобы узнать известное.',
    cancelled: 'Этот запуск отменён. Отмена не является завершением.',
  },
};

export function ResearchRunFeature({
  locale = 'en',
  state = 'empty',
  question,
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
}: ResearchRunFeatureProps) {
  const [draft, setDraft] = useState<string>('');
  const [recorded, setRecorded] = useState<string | null>(question ?? null);
  const headingId = useId();
  const questionId = headingId + '-question';
  const copy = COPY[locale];
  const notice = STATE_NOTICE[locale][state];
  const selected = scope ?? [];
  const frozen = selected.slice();
  const unknownOutcome = firstCause !== undefined && firstCause.dispatch_state === 'OUTCOME_UNKNOWN';
  const hasQuestion = question !== undefined || progress !== undefined || firstCause !== undefined;

  function submit() {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || busy || !canSubmit || hasQuestion) return;
    setRecorded(trimmed);
    setDraft('');
    if (onAsk !== undefined) onAsk(trimmed, frozen);
  }

  return (
    <section className="er-research-run" aria-labelledby={headingId}>
      <h2 className="er-research-run__heading" id={headingId}>{copy.heading}</h2>
      <p className="er-research-run__lead">{copy.lead}</p>

      {!hasQuestion && <Field
        id={questionId}
        label={copy.questionLabel}
        hint={copy.questionHint}
        placeholder={copy.questionPlaceholder}
        value={draft}
        disabled={busy}
        onChange={function (event: React.ChangeEvent<HTMLInputElement>) { setDraft(event.target.value); }}
      />}
      <div className="er-research-run__scope">
        <h3 className="er-research-run__scope-heading">{copy.scopeHeading}</h3>
        {selected.length === 0 ? (
          <p className="er-research-run__scope-empty">{copy.scopeEmpty}</p>
        ) : (
          <ul className="er-research-run__scope-list">
            {selected.map(function (item) {
              return <li className="er-research-run__scope-item" key={item.id}>{item.label}</li>;
            })}
          </ul>
        )}
        <p className="er-research-run__scope-count">{copy.scopeCount(selected.length)}</p>
      </div>

      <div className="er-research-run__actions">
        {!hasQuestion && <Button
          variant="primary"
          loading={busy}
          disabled={busy || canSubmit === false || draft.trim().length === 0}
          onClick={submit}
        >
          {busy ? copy.asking : copy.ask}
        </Button>}
        {onReadStatus === undefined ? null : (
          <Button variant="tonal" disabled={busy} onClick={onReadStatus}>{copy.readStatus}</Button>
        )}
        {onRefreshSnapshot === undefined ? null : (
          <Button variant="text" disabled={busy} onClick={onRefreshSnapshot}>{copy.refreshSnapshot}</Button>
        )}
      </div>

      {recorded === null ? null : (
        <p className="er-research-run__recorded">
          <span className="er-research-run__recorded-label">{copy.recordedQuestion}</span>
          <span className="er-research-run__recorded-value">{recorded}</span>
        </p>
      )}

      <Status tone={state === 'error' ? 'error' : 'neutral'}>{notice}</Status>

      {progress === undefined ? null : (
        <section className="er-research-run__progress" aria-label={copy.progressHeading}>
          <h3 className="er-research-run__progress-heading">{copy.progressHeading}</h3>
          <dl className="er-research-run__progress-list">
            <dt>{copy.stagePrefix}</dt>
            <dd>
              {progress.execution_state === 'ENGINE_COMPLETED'
                ? copy.completedStages(progress.next_stage_index)
                : copy.nextStage(progress.next_stage_index)} · {progress.engine_status}
            </dd>
          </dl>
          <details>
            <summary>{copy.details}</summary>
            <dl className="er-research-run__details">
              <dt>{copy.generationLabel}</dt>
              <dd>{progress.deployment_generation}</dd>
            </dl>
          </details>
          {progress.answer.availability === 'unavailable' ? (
            <p className="er-research-run__answer">{copy.answerUnavailable}</p>
          ) : (
            <p className="er-research-run__answer">{copy.answerDraft}</p>
          )}
          {progress.execution_state === 'ENGINE_COMPLETED' ? (
            <p className="er-research-run__caution">{copy.completedNotAccepted}</p>
          ) : null}
          {progress.execution_state === 'CANCELLED' ? (
            <p className="er-research-run__caution">{copy.cancelledHint}</p>
          ) : null}
        </section>
      )}

      {(snapshot !== undefined || onRefreshSnapshot !== undefined) && <section className="er-research-run__snapshot">
        <h3 className="er-research-run__snapshot-heading">{copy.snapshotHeading}</h3>
        {snapshot === undefined ? (
          <p className="er-research-run__snapshot-none">{copy.snapshotNone}</p>
        ) : (
          <p className="er-research-run__snapshot-state">{SNAPSHOT_LABEL[locale][snapshot.state]}</p>
        )}
      </section>}

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
          <details><summary>{copy.details}</summary>
          <dl className="er-research-run__failure-list">
            <dt>code</dt>
            <dd>{firstCause.code}</dd>
            {firstCause.stage === undefined ? null : (
              <>
                <dt>stage</dt>
                <dd>{firstCause.stage}</dd>
              </>
            )}
            {firstCause.phase === undefined ? null : (
              <>
                <dt>phase</dt>
                <dd>{PHASE_LABEL[locale][firstCause.phase]}</dd>
              </>
            )}
            <dt>retryable</dt>
            <dd>{firstCause.retryable === true ? 'yes' : 'no'}</dd>
            <dt>dispatch</dt>
            {firstCause.dispatch_state === undefined ? null : (
              <dd>{DISPATCH_LABEL[locale][firstCause.dispatch_state]}</dd>
            )}
            <dt>references</dt>
            {firstCause.references_intact === undefined ? null : (
              <dd>{REFERENCES_LABEL[locale][firstCause.references_intact]}</dd>
            )}
            <dt>recovery</dt>
            {firstCause.recovery_action === undefined ? null : (
              <dd>{RECOVERY_LABEL[locale][firstCause.recovery_action]}</dd>
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
    </section>
  );
}
