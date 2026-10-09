import { useCallback, useId, useState } from 'react';
import { Button, Dialog, Field, Status } from '../../../primitives/primitives';
import './research-fixture.css';

/**
 * U2-R Research fixture: question first, then a locally reviewable sample report.
 *
 * Every visible action works without a parent callback and no timer exists, so nothing here can imply
 * an automatic completion. No-hit, four separate budget limits, the snapshot sample and report
 * acceptance stay distinct, because collapsing them is the failure this fixture must make visible.
 */

const copy = {
  en: {
    heading: 'Ask a research question',
    lead: 'Bring your sources together. Ask a focused question and follow the evidence.',
    questionLabel: 'Research question',
    questionPlaceholder: 'How do sources support a research claim?',
    questionHint: 'The question stays in this browser session only.',
    noScope: 'Choose at least one admitted source in Sources before asking.',
    reset: 'Clear sample request',
    refreshed: (count: number) => `Local sample refreshed ${count} time${count === 1 ? '' : 's'}. No live request was made.`,
    ask: 'Ask',
    loading: 'Sample request recorded. Live progress is unavailable in this preview.',
    readback: 'Progress is unknown until the next status readback. This notice says nothing about the run itself.',
    outcomeUnknown: 'The outcome of this request is not yet known. Check the status readback before drawing any conclusion.',
    noHits: 'No source matched this question. That is not proof the corpus has nothing to say.',
    budgetsHeading: 'Budget limits are separate facts',
    budgetCandidate: 'Candidate budget: some candidates were not read, so they were not examined.',
    budgetScan: 'Scan budget: some candidates were not scanned, so they were not examined.',
    budgetEvidence: 'Evidence budget: some evidence was not resolved, so it remains unresolved.',
    budgetContext: 'Context budget: some candidates were left out of the prompt, so they were never shown to the model.',
    budgetNote: 'A limit on one budget is not a failure, and it never makes a citation invalid.',
    scopeCount: (count: number) => `${count} ${count === 1 ? 'source' : 'sources'} in scope`,
    showReport: 'Show sample report',
    hideReport: 'Hide sample report',
    reportHeading: 'Sample report',
    reportLead: 'Local sample · original source scope · acceptance unknown',
    reportBody: 'An explicit source scope keeps a claim connected to the material that informed it. Review the original passage, keep uncertainty visible, and distinguish a saved draft from an accepted report.',
    evidenceHeading: 'Source passage',
    evidenceBody: '“Clarity starts with a clear relationship between the question, the source, and the claim.”',
    cite: 'View citation',
    citationTitle: 'Citation detail',
    citationBody: 'Citation resolution stays separate from semantic support. A resolved locator is not proof that it supports this sentence.',
    closeCitation: 'Back to the report',
    snapshotHeading: 'Snapshot sample',
    snapshotActive: 'A session is active. This local sample shows the shape of a snapshot, not live progress.',
    snapshotCancelled: 'A session was cancelled. Cancellation is not completion.',
    snapshotCompleted: 'A session reached engine completion. That is not report acceptance or publication.',
    refreshSample: 'Refresh snapshot sample',
    degraded: 'Progress is unavailable until a fresh status readback succeeds.',
    error: 'This request could not be completed. Consult the status readback for what is known.',
    complete: 'A sample report is ready to review locally.',
  },
  ru: {
    heading: 'Задайте исследовательский вопрос',
    lead: 'Соберите источники вместе. Задайте точный вопрос и проследите связь с доказательствами.',
    questionLabel: 'Исследовательский вопрос',
    questionPlaceholder: 'Как источники помогают обосновать исследовательский вывод?',
    questionHint: 'Вопрос остаётся только в этом сеансе браузера.',
    noScope: 'Перед вопросом выберите хотя бы один допущенный источник в библиотеке.',
    reset: 'Убрать учебный запрос',
    refreshed: (count: number) => `Образец обновлён локально: ${count}. Запросов к серверу не было.`,
    ask: 'Спросить',
    loading: 'Учебный запрос записан. Прогресс сервера в этом макете недоступен.',
    readback: 'Прогресс неизвестен до следующей проверки статуса. Это уведомление ничего не говорит о самом запуске.',
    outcomeUnknown: 'Исход этого запроса пока неизвестен. Проверьте статус, прежде чем делать какой-либо вывод.',
    noHits: 'Ни один источник не подошёл к этому вопросу. Это не доказательство, что в корпусе ничего нет.',
    budgetsHeading: 'Лимиты бюджета — отдельные факты',
    budgetCandidate: 'Бюджет кандидатов: часть кандидатов не прочитана, поэтому она не изучена.',
    budgetScan: 'Бюджет сканирования: часть кандидатов не просканирована, поэтому она не изучена.',
    budgetEvidence: 'Бюджет доказательств: часть доказательств не разрешена, поэтому она остаётся неразрешённой.',
    budgetContext: 'Бюджет контекста: часть кандидатов не попала в запрос, поэтому модель их не видела.',
    budgetNote: 'Исчерпание одного бюджета — не ошибка и никогда не делает цитату недействительной.',
    scopeCount: (count: number) => `${count} ${count === 1 ? 'источник' : 'источников'} в области`,
    showReport: 'Показать образец отчёта',
    hideReport: 'Скрыть образец отчёта',
    reportHeading: 'Образец отчёта',
    reportLead: 'Локальный образец · первоначальный набор источников · принятие неизвестно',
    reportBody: 'Явный набор источников сохраняет связь утверждения с материалами, на которых оно основано. Проверяйте первоначальный фрагмент, показывайте неопределённость и отличайте сохранённый черновик от принятого отчёта.',
    evidenceHeading: 'Фрагмент источника',
    evidenceBody: '«Ясность начинается с понятной связи между вопросом, источником и утверждением».',
    cite: 'Открыть цитату',
    citationTitle: 'Сведения о цитате',
    citationBody: 'Разрешение цитаты остаётся отдельным от семантической поддержки. Найденный локатор — не доказательство, что он поддерживает это предложение.',
    closeCitation: 'Вернуться к отчёту',
    snapshotHeading: 'Образец снимка',
    snapshotActive: 'Сеанс активен. Этот локальный образец показывает форму снимка, а не живой прогресс.',
    snapshotCancelled: 'Сеанс отменён. Отмена — не завершение.',
    snapshotCompleted: 'Сеанс достиг завершения движка. Это не принятие и не публикация отчёта.',
    refreshSample: 'Обновить образец снимка',
    degraded: 'Прогресс недоступен до свежей проверки статуса.',
    error: 'Запрос не удалось завершить. Сведите статус к тому, что известно.',
    complete: 'Образец отчёта готов к просмотру локально.',
  },
} as const;

export type ResearchFixtureState = 'empty' | 'loading' | 'degraded' | 'error' | 'complete';
export type ResearchFixtureSnapshot = 'active' | 'cancelled' | 'engine-completed' | 'none';
export type ResearchFixtureBudget = 'candidate' | 'scan' | 'evidence' | 'context';

export interface ResearchFixtureProps {
  /** One of five view states. No-hit, budget and snapshot notices are additional, never replacements. */
  readonly state?: ResearchFixtureState;
  /** Display locale. English is the default; long Russian is a first-class parity lane. */
  readonly locale?: 'en' | 'ru';
  /** Number of sources in scope, shown as plain text rather than a raw identifier. */
  readonly scopeCount?: number;
  /** Show the no-hit notice. Deliberately distinct from corpus absence. */
  readonly noHits?: boolean;
  /** Request uncertainty is independent of a confirmed failure. */
  readonly outcomeUnknown?: boolean;
  /** Which of the four separate budgets is being reported. No budget implies any other. */
  readonly budget?: ResearchFixtureBudget;
  /** Explicit-refresh snapshot sample. Never presented as proactive streaming progress. */
  readonly snapshot?: ResearchFixtureSnapshot;
  /** Called with the trimmed question and the scope frozen at submit time. */
  readonly onAsk?: (question: string, frozenScopeCount: number) => void;
  /** Called when the sample report is shown or hidden. */
  readonly onToggleSampleReport?: (visible: boolean) => void;
  /** Replaces the local citation dialog when supplied. */
  readonly onCitation?: () => void;
  /** Called with a requested index when the reviewer refreshes the local snapshot sample. */
  readonly onRefreshSampleSnapshot?: (index: number, snapshot: ResearchFixtureSnapshot) => void;
}

export function ResearchFixture({
  state = 'empty',
  locale = 'en',
  scopeCount = 0,
  noHits = false,
  outcomeUnknown = false,
  budget,
  snapshot = 'none',
  onAsk,
  onToggleSampleReport,
  onCitation,
  onRefreshSampleSnapshot,
}: ResearchFixtureProps) {
  const text = copy[locale];
  const headingId = useId();
  const reportHeadingId = useId();
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [reportVisible, setReportVisible] = useState(false);
  const [citationOpen, setCitationOpen] = useState(false);
  const [snapshotIndex, setSnapshotIndex] = useState(0);

  const trimQuestion = question.trim();
  const frozenScopeCount = scopeCount;

  // A local busy flag with no timer behind it. It clears only from an explicit reviewer action, so
  // this fixture can never suggest an automatic completion.
  const submit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (trimQuestion.length === 0 || frozenScopeCount === 0 || busy || state === 'loading') return;
      setBusy(true);
      onAsk?.(trimQuestion, frozenScopeCount);
    },
    [busy, frozenScopeCount, onAsk, state, trimQuestion],
  );

  // The report toggle is independent of the busy flag, and remains available in every state.
  const toggleReport = useCallback(
    () => {
      const next = !reportVisible;
      setReportVisible(next);
      onToggleSampleReport?.(next);
    },
    [onToggleSampleReport, reportVisible],
  );

  const refreshSample = useCallback(
    () => {
      const nextIndex = snapshotIndex + 1;
      setSnapshotIndex(nextIndex);
      onRefreshSampleSnapshot?.(nextIndex, snapshot);
    },
    [onRefreshSampleSnapshot, snapshot, snapshotIndex],
  );

  const openCitation = useCallback(
    () => {
      if (onCitation !== undefined) {
        onCitation();
        return;
      }
      setCitationOpen(true);
    },
    [onCitation],
  );

  const loading = busy || state === 'loading';

  return (
    <section className='er-research-fixture' aria-labelledby={headingId} lang={locale}>
      <h2 className='er-research-fixture__heading' id={headingId}>{text.heading}</h2>
      <p className='er-research-fixture__lead'>{text.lead}</p>

      <form className='er-research-fixture__form' onSubmit={submit}>
        <Field
          label={text.questionLabel}
          hint={text.questionHint}
          placeholder={text.questionPlaceholder}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <span className='er-research-fixture__form-actions'>
          <Button type='submit' loading={loading} disabled={loading || scopeCount === 0 || trimQuestion.length === 0}>{text.ask}</Button>
          <Button variant='tonal' onClick={toggleReport}>
            {reportVisible ? text.hideReport : text.showReport}
          </Button>
          {busy && <Button variant='text' onClick={() => setBusy(false)}>{text.reset}</Button>}
        </span>
        <p className='er-research-fixture__scope'>{text.scopeCount(scopeCount)}</p>
        {scopeCount === 0 && <p className='er-research-fixture__scope'>{text.noScope}</p>}
      </form>

      {loading && <Status>{text.loading}</Status>}
      {!loading && state === 'degraded' && <Status tone='error'>{text.degraded}</Status>}
      {!loading && state === 'complete' && <Status>{text.complete}</Status>}
      {!loading && state === 'error' && <Status tone='error'>{text.error}</Status>}
      {outcomeUnknown && <p className='er-research-fixture__notice'>{text.outcomeUnknown}</p>}
      {state === 'degraded' && <p className='er-research-fixture__notice'>{text.readback}</p>}

      {noHits && <p className='er-research-fixture__notice'>{text.noHits}</p>}

      {budget !== undefined && <details className='er-research-fixture__budgets'>
        <summary>{text.budgetsHeading}</summary>
        <ul>
          {budget === 'candidate' && <li>{text.budgetCandidate}</li>}
          {budget === 'scan' && <li>{text.budgetScan}</li>}
          {budget === 'evidence' && <li>{text.budgetEvidence}</li>}
          {budget === 'context' && <li>{text.budgetContext}</li>}
        </ul>
        <p className='er-research-fixture__budget-note'>{text.budgetNote}</p>
      </details>}

      {snapshot !== 'none' && (
        <details className='er-research-fixture__snapshot'>
          <summary>{text.snapshotHeading}</summary>
          <p>
            {snapshot === 'active' && text.snapshotActive}
            {snapshot === 'cancelled' && text.snapshotCancelled}
            {snapshot === 'engine-completed' && text.snapshotCompleted}
          </p>
          <Button variant='tonal' onClick={refreshSample}>{text.refreshSample}</Button>
          {snapshotIndex > 0 && <p className='er-research-fixture__snapshot-index'>{text.refreshed(snapshotIndex)}</p>}
        </details>
      )}

      {reportVisible && (
        <article className='er-research-fixture__report' aria-labelledby={reportHeadingId}>
          <h3 id={reportHeadingId}>{text.reportHeading}</h3>
          <p className='er-research-fixture__report-lead'>{text.reportLead}</p>
          <p className='er-research-fixture__report-body'>{text.reportBody}</p>
          <section className='er-research-fixture__evidence'>
            <h4>{text.evidenceHeading}</h4>
            <p>{text.evidenceBody}</p>
          </section>
          <Button variant='text' onClick={openCitation}>{text.cite}</Button>
        </article>
      )}

      <Dialog open={citationOpen} title={text.citationTitle} onClose={() => setCitationOpen(false)}>
        <p>{text.citationBody}</p>
        <Button variant='tonal' onClick={() => setCitationOpen(false)}>{text.closeCitation}</Button>
      </Dialog>
    </section>
  );
}
