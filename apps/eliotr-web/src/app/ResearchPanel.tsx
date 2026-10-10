import { useEffect, useRef, useState } from 'react';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { WorkspaceLink } from '../routes/WorkspaceLink';
import { Button, OperationAnnouncement, ResearchRunFeature, Status } from '@eliotr/ui';
import type { ResearchRunLaunchView, VersionedRef } from '@eliotr/owner-api-client';
import type { BoundWorkspaceApis } from './runtime';
import type { PrivacyController, SessionContext } from './privacy';
import type { NextQuestionSource } from './NextQuestionScope';
import { researchQueryOptions } from '../query/research';
import { protectedQueryKey, runProtectedRead } from '../query/client';
import { ReportPanel } from './ReportPanel';
import { usePaneAnnouncement } from './usePaneAnnouncement';

interface ResearchIntent {
  readonly body: string; readonly key: string; readonly question: string;
  readonly scope: readonly { readonly id: string; readonly label: string }[];
  readonly phase: 'pending' | 'unknown' | 'admitted';
  readonly launch?: ResearchRunLaunchView;
}
interface ResearchMemory {
  readonly intent?: ResearchIntent;
  readonly observedLaunch?: ResearchRunLaunchView;
  readonly artifact?: VersionedRef;
}
const copy = {
  en: { statusUnavailable: 'The current run status could not be read.', working: 'Checking the current question.', runRead: 'Run status updated.', runFailed: 'The run reported a failure.', runComplete: 'The engine finished. Review its result.', cancelled: 'The run was cancelled.', historyLoaded: 'Recent research loaded.', scope: 'Choose sources', scopeStale: 'Review your selected sources again before asking a new question.', blocked: 'Research needs a current configuration check.', check: 'Check research readiness', connections: 'Review connections', history: 'Recent research', readHistory: 'Refresh recent research', openRun: 'Read this run', report: 'Open saved report', unknown: 'The launch outcome is unknown. The original question and request identity are preserved.', recover: 'Reconcile this question', same: 'While this workspace remains open, recovery reads the acknowledged run or reuses the original request and identity when its acknowledgement is missing.', next: 'Ask another question', input: 'The question could not be prepared. Review its text and source selection.', unavailable: 'Recent research could not be read. Try a fresh read.', noRuns: 'Your questions and saved reports will appear here.', incomplete: 'The engine has not provided a draft report yet.' },
  ru: { statusUnavailable: 'Не удалось прочитать текущий статус запуска.', working: 'Проверяется текущий вопрос.', runRead: 'Статус запуска обновлён.', runFailed: 'Запуск сообщил об ошибке.', runComplete: 'Движок завершил работу. Проверьте результат.', cancelled: 'Запуск отменён.', historyLoaded: 'Последние исследования прочитаны.', scope: 'Выбрать источники', scopeStale: 'Перед новым вопросом проверьте выбранные источники ещё раз.', blocked: 'Нужна актуальная проверка настроек исследования.', check: 'Проверить готовность исследования', connections: 'Проверить подключения', history: 'Последние исследования', readHistory: 'Обновить последние исследования', openRun: 'Прочитать этот запуск', report: 'Открыть сохранённый отчёт', unknown: 'Исход запуска неизвестен. Исходный вопрос и идентификатор запроса сохранены.', recover: 'Проверить этот вопрос', same: 'Пока рабочая область открыта, читается подтверждённый запуск. Если подтверждение потеряно, повторяется исходный запрос с тем же идентификатором.', next: 'Задать другой вопрос', input: 'Не удалось подготовить вопрос. Проверьте текст и выбранные источники.', unavailable: 'Не удалось прочитать последние исследования. Повторите чтение.', noRuns: 'Здесь появятся ваши вопросы и сохранённые отчёты.', incomplete: 'Движок пока не предоставил черновик отчёта.' },
} as const;

/** One explicit intent owns admission. Polling, navigation and history never allocate a run. */
export function ResearchPanel({ apis, privacy, context, locale, scope, scopeCurrent, isScopeCurrent }: {
  readonly apis: BoundWorkspaceApis; readonly privacy: PrivacyController; readonly context: SessionContext;
  readonly locale: 'en' | 'ru'; readonly scope: readonly NextQuestionSource[]; readonly scopeCurrent: boolean;
  readonly isScopeCurrent: () => boolean;
}) {
  const client = useQueryClient(), text = copy[locale];
  const memoryKey = [...protectedQueryKey(context, 'research'), 'local-intent'];
  const memory = useQuery<ResearchMemory>({ queryKey: memoryKey, queryFn: skipToken, gcTime: Infinity });
  const options = researchQueryOptions({ ...apis.research, configuration: apis.connections.configuration }, privacy, context);
  const configuration = useQuery(options.configuration());
  const history = useQuery(options.history());
  const saved = memory.data, launch = saved?.intent?.launch ?? saved?.observedLaunch;
  const status = useQuery(launch ? { ...options.status(launch),
    refetchInterval: query => query.state.data?.execution_state === 'ACTIVE' &&
      ['queued', 'running', 'waiting'].includes(query.state.data.engine_status) ? 5000 : false,
    refetchIntervalInBackground: false,
  } : { queryKey: [...protectedQueryKey(context, 'research'), 'status-unselected'], queryFn: skipToken });
  const [busy, setBusy] = useState(false), [inputError, setInputError] = useState(false);
  const [heldDraft, setHeldDraft] = useState<{ readonly context: SessionContext; readonly text: string } | undefined>(undefined);
  const nextQuestionDraft = heldDraft !== undefined && heldDraft.context === context && privacy.isCurrent(context)
    ? heldDraft.text : '';
  const running = useRef(false), mounted = useRef(true), controller = useRef<AbortController | undefined>(undefined);
  const read = () => client.getQueryData<ResearchMemory>(memoryKey) ?? {};
  const write = (update: (old: ResearchMemory) => ResearchMemory) => {
    if (privacy.isCurrent(context)) client.setQueryData<ResearchMemory>(memoryKey, old => update(old ?? {}));
  };
  useEffect(() => {
    mounted.current = true;
    const clearStaleDraft = () => {
      if (!privacy.isCurrent(context)) setHeldDraft(undefined);
    };
    const unsubscribe = privacy.subscribe(clearStaleDraft);
    clearStaleDraft();
    return () => {
      unsubscribe();
      mounted.current = false; controller.current?.abort();
      if (running.current && privacy.isCurrent(context)) client.setQueryData<ResearchMemory>(memoryKey, old =>
        old?.intent ? { ...old, intent: { ...old.intent, phase: 'unknown' } } : old);
    };
  }, [client, context, privacy]);
  const run = (action: (signal: AbortSignal) => Promise<void>) => {
    if (running.current || !privacy.isCurrent(context)) return;
    running.current = true; controller.current = new AbortController(); setBusy(true);
    const signal = controller.current.signal;
    void action(signal).catch(() => {
      write(old => old.intent ? { ...old, intent: { ...old.intent, phase: 'unknown' } } : old);
    }).finally(() => { running.current = false; if (mounted.current) setBusy(false); });
  };
  const admit = async (intent: ResearchIntent, signal: AbortSignal) => {
    const result = await runProtectedRead(privacy, context, signal, readSignal =>
      apis.research.runs.startResearchRun(intent.body, intent.key, context.deploymentGeneration, readSignal));
    write(old => old.intent?.key === intent.key ? { ...old, intent: { ...intent, phase: 'admitted', launch: result } } : old);
  };
  const ask = (question: string) => {
    if (read().intent || read().observedLaunch || running.current || !scopeCurrent || !isScopeCurrent() || !privacy.isCurrent(context) ||
      configuration.isError || configuration.isFetching || !configuration.data ||
      client.getQueryData(options.configuration().queryKey) !== configuration.data || configuration.data.run_readiness === 'blocked') return;
    try {
      const body = apis.research.runs.researchRunBody(question, scope.map(source => source.id));
      const intent: ResearchIntent = Object.freeze({ body, key: apis.sources.mintIntent(), question,
        scope: Object.freeze(scope.map(source => Object.freeze({ id: source.id, label: source.label }))), phase: 'pending' });
      write(old => ({ ...old, intent }));
      if (read().intent?.key !== intent.key) return;
      setInputError(false); setHeldDraft(undefined);
      run(signal => admit(intent, signal));
    } catch { setInputError(true); }
  };
  const reconcile = () => {
    const intent = read().intent; if (!intent || intent.phase === 'pending') return;
    run(async signal => {
      // History has no request identity and is independent of same-key reconciliation.
      if (signal.aborted || !privacy.isCurrent(context)) return;
      if (intent.launch) {
        await client.fetchQuery(options.status(intent.launch));
        write(old => old.intent?.key === intent.key ? { ...old, intent: { ...intent, phase: 'admitted' } } : old);
      } else await admit(intent, signal);
    });
  };
  const progress = status.isError ? undefined : status.data;
  const terminal = saved?.intent?.launch && progress?.workflow_instance_id === saved.intent.launch.workflow_instance_id &&
    progress.execution_state !== 'ACTIVE' && !status.isError && !status.isFetching;
  const state = saved?.intent?.phase === 'unknown' || status.isError ? 'degraded'
    : progress?.execution_state === 'CANCELLED' ? 'cancelled'
    : progress?.failure ? 'error' : progress?.execution_state === 'ENGINE_COMPLETED' ? 'useful'
    : launch || busy ? 'loading' : 'empty';
  const announcement = usePaneAnnouncement(busy ? text.working
    : inputError ? text.input
    : saved?.intent?.phase === 'unknown' ? text.unknown
    : status.isError ? text.statusUnavailable
    : progress?.failure ? text.runFailed
    : progress?.execution_state === 'CANCELLED' ? text.cancelled
    : progress?.execution_state === 'ENGINE_COMPLETED' ? text.runComplete
    : progress ? text.runRead : history.isError ? text.unavailable : history.data ? text.historyLoaded : '');
  if (saved?.artifact) return <ReportPanel key={`${saved.artifact.id}:${saved.artifact.revision}`} locale={locale} apis={apis} privacy={privacy} context={context} artifactRef={saved.artifact}
    onOpenDraft={artifact => write(old => ({ ...old, artifact }))}
    onClose={() => write(old => { const { artifact: _artifact, ...rest } = old; return rest; })} />;
  return <>
    <OperationAnnouncement>{announcement}</OperationAnnouncement>
    {!scopeCurrent && !saved?.intent && <p>{text.scopeStale} <WorkspaceLink className="er-shell-link" to="/sources">{text.scope}</WorkspaceLink></p>}
    {configuration.isError || !configuration.data || configuration.data.run_readiness === 'blocked' ? <div>
      <Status>{text.blocked}</Status><div className="er-live-actions"><Button variant="tonal" disabled={configuration.isFetching} onClick={() => { void configuration.refetch(); }}>{text.check}</Button><WorkspaceLink className="er-shell-link" to="/connections">{text.connections}</WorkspaceLink></div>
    </div> : null}
    {inputError && <Status tone="error">{text.input}</Status>}
    <ResearchRunFeature key={saved?.intent?.key ?? 'next-question'} locale={locale} state={state}
      scope={saved?.intent?.scope ?? scope} busy={busy}
      questionHeld={saved?.intent !== undefined || saved?.observedLaunch !== undefined}
      draftQuestion={nextQuestionDraft} onDraftQuestionChange={value => {
        if (mounted.current && privacy.isCurrent(context)) setHeldDraft({ context, text: value });
      }}
      canSubmit={!saved?.intent && !saved?.observedLaunch && scopeCurrent && !configuration.isError && !configuration.isFetching && configuration.data !== undefined && configuration.data.run_readiness !== 'blocked'}
      {...(saved?.intent ? { question: saved.intent.question } : {})}
      {...(progress ? { progress, ...(progress.failure ? { firstCause: progress.failure } : {}) } : {})}
      onAsk={ask} {...(launch ? { onReadStatus: () => { void status.refetch(); } } : {})}
      {...(saved?.intent?.phase === 'unknown' ? { onRecover: reconcile } : {})} />
    {saved?.intent?.phase === 'unknown' && <div><Status>{text.unknown}</Status><p>{text.same}</p>
      <Button variant="tonal" disabled={busy} onClick={reconcile}>{text.recover}</Button></div>}
    {terminal && <Button variant="text" onClick={() => {
      if (privacy.isCurrent(context) && !running.current) write(old => {
        const { intent: _intent, observedLaunch: _launch, ...rest } = old; return rest;
      });
    }}>{text.next}</Button>}
    {progress?.answer.availability === 'draft' && <div className="er-live-actions"><Button variant="primary" onClick={() => { if (privacy.isCurrent(context) && progress.answer.availability === 'draft') { const artifact = progress.answer.artifact_ref; write(old => ({ ...old, artifact })); } }}>{text.report}</Button></div>}
    <section className="er-live-history" aria-label={text.history}><h2>{text.history}</h2>
      <Button variant="text" disabled={history.isFetching} onClick={() => { void history.refetch(); }}>{text.readHistory}</Button>
      {history.isError ? <Status>{text.unavailable}</Status> : history.data?.runs.length === 0 ? <p>{text.noRuns}</p> : null}
      <ul>{!history.isError && history.data?.runs.map(entry => <li key={entry.status.workflow_instance_id}>
        <span>{entry.created_at}</span><Button variant="text" disabled={saved?.intent !== undefined} onClick={() => {
          const observed = entry.status; write(old => ({ ...old, observedLaunch: { workflow_instance_id: observed.workflow_instance_id, investigation_ref: observed.investigation_ref, deployment_generation: observed.deployment_generation } }));
        }}>{text.openRun}</Button>
        {entry.status.answer.availability === 'draft' && <Button variant="tonal" onClick={() => {
          if (entry.status.answer.availability === 'draft') { const artifact = entry.status.answer.artifact_ref; write(old => ({ ...old, artifact })); }
        }}>{text.report}</Button>}
      </li>)}</ul>
      <ul>{!history.isError && history.data?.saved_drafts.map(draft => <li key={`${draft.artifact_ref.id}:${draft.artifact_ref.revision}`}>
        <span>{draft.created_at}</span><Button variant="tonal" onClick={() => write(old => ({ ...old, artifact: draft.artifact_ref }))}>{text.report}</Button>
      </li>)}</ul>
    </section>
  </>;
}
