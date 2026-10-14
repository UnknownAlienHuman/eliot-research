import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router';
import { Button, OperationAnnouncement, Status, StudioFeature, STUDIO_COPY } from '@eliotr/ui';
import type { VersionedRef, WikiProposalReadView, WikiProposalFromRunView, WikiPublicationView } from '@eliotr/owner-api-client';
import { classifyMutationOutcome } from '@eliotr/owner-api-client';
import type { BoundWorkspaceApis } from './runtime';
import { isWorkspaceRequestError } from './runtime';
import type { PrivacyController, SessionContext } from './privacy';
import { protectedQueryKey, runProtectedRead } from '../query/client';
import { studioQueryOptions } from '../query/studio';
import { researchQueryOptions } from '../query/research';
import { ReportPanel } from './ReportPanel';
import { usePaneAnnouncement } from './usePaneAnnouncement';
import { hasInboxStudioSelectionState, matchesInboxStudioReadback, resolveInboxStudioSelection } from './inboxStudioSelection';

type StudioIntent = ({ readonly kind: 'edit'; readonly base: WikiProposalReadView; readonly title: string; readonly body: string; readonly note: string }
  | { readonly kind: 'publish'; readonly base: WikiProposalReadView; readonly expectedHead: number })
  & { readonly key: string; readonly phase: 'pending' | 'unknown' | 'rejected' };
interface StudioMemory {
  readonly selected?: VersionedRef; readonly artifact?: VersionedRef; readonly intent?: StudioIntent;
  readonly edited?: WikiProposalFromRunView; readonly published?: WikiPublicationView; readonly publishedProposalRef?: VersionedRef;
  readonly reviewedEdit?: Extract<StudioIntent, { readonly kind: 'edit' }>;
}
const sameRef = (left: VersionedRef, right: VersionedRef) => left.id === right.id && left.revision === right.revision;
const copy = {
  en: { working: 'Checking the current action.', reading: 'Reading saved work.', loaded: 'Saved work loaded.', drafts: 'Wiki drafts', read: 'Refresh saved work', previous: 'Previous page', next: 'More drafts', recent: 'Saved reports', report: 'Open saved report', unknown: 'The last action has no confirmed outcome. Its original draft, content and request identity are preserved.', recover: 'Check the same action', inputs: 'The edit could not be prepared. Review its title and text.', review: 'Review the edit again', published: 'Publication confirmed for this Wiki page.', edited: 'A new draft revision was returned. The previous page was preserved.', failed: 'The selected draft could not be read. No saved text is shown.', reread: 'Read the selected draft again' },
  ru: { working: 'Проверяется текущее действие.', reading: 'Читаются сохранённые материалы.', loaded: 'Сохранённые материалы прочитаны.', drafts: 'Черновики Wiki', read: 'Обновить сохранённые материалы', previous: 'Предыдущая страница', next: 'Другие черновики', recent: 'Сохранённые отчёты', report: 'Открыть сохранённый отчёт', unknown: 'Исход последнего действия не подтверждён. Исходный черновик, текст и идентификатор запроса сохранены.', recover: 'Проверить то же действие', inputs: 'Не удалось подготовить правку. Проверьте заголовок и текст.', review: 'Проверить правку ещё раз', published: 'Публикация этой страницы Wiki подтверждена.', edited: 'Получена новая версия черновика. Предыдущая страница сохранена.', failed: 'Не удалось прочитать выбранный черновик. Сохранённый текст не показывается.', reread: 'Прочитать выбранный черновик снова' },
} as const;
const publicationReadbackCopy = {
  en: { failed: 'Publication is confirmed, but reading the published page failed. Retry the read; it will not publish again.', retry: 'Retry reading the published page' },
  ru: { failed: 'Публикация подтверждена, но не удалось прочитать опубликованную страницу. Повторите чтение; публикация не будет отправлена снова.', retry: 'Повторить чтение опубликованной страницы' },
} as const;
const savedReportsCopy = {
  en: { reading: 'Reading saved reports.', failed: 'Saved reports could not be read. Try a fresh read.',
    refresh: 'Refresh saved reports', empty: 'No saved reports yet.' },
  ru: { reading: 'Читаются сохранённые отчёты.', failed: 'Не удалось прочитать сохранённые отчёты. Повторите чтение.',
    refresh: 'Обновить сохранённые отчёты', empty: 'Сохранённых отчётов пока нет.' },
} as const;
const inboxSelectionCopy = {
  en: 'The Inbox proposal could not be verified. Reopen it from the Inbox.',
  ru: 'Не удалось проверить предложение из входящих. Откройте его снова из входящих.',
} as const;

/** Read, copy-on-write edit and publication use only the accepted owner client. */
export function StudioPanel({ apis, privacy, context, locale }: {
  readonly apis: BoundWorkspaceApis; readonly privacy: PrivacyController; readonly context: SessionContext; readonly locale: 'en' | 'ru';
}) {
  const client = useQueryClient(), text = copy[locale], reportText = savedReportsCopy[locale], readbackText = publicationReadbackCopy[locale];
  const location = useLocation();
  const memoryKey = useMemo(() => [...protectedQueryKey(context, 'studio'), 'local-intent'], [context]);
  const memory = useQuery<StudioMemory>({ queryKey: memoryKey, queryFn: skipToken, gcTime: Infinity });
  let proposalKey: (string | number)[] = [];
  const options = studioQueryOptions(apis.studio, privacy, context, () => client.getQueryData<WikiProposalReadView>(proposalKey));
  const proposals = useQuery(options.proposals());
  const selectedOptions = memory.data?.selected ? options.proposal(memory.data.selected) : undefined;
  proposalKey = selectedOptions?.queryKey ?? [...protectedQueryKey(context, 'studio'), 'proposal-unselected'];
  const selected = useQuery(selectedOptions ?? { queryKey: proposalKey, queryFn: skipToken });
  const view = selected.isError ? undefined : selected.data;
  const body = useQuery(view ? options.body(view) : { queryKey: [...protectedQueryKey(context, 'studio'), 'body-unselected'], queryFn: skipToken });
  const research = researchQueryOptions({ ...apis.research, configuration: apis.connections.configuration }, privacy, context);
  const history = useQuery(research.history());
  const [busy, setBusy] = useState(false), [inboxSelectionFailed, setInboxSelectionFailed] = useState(false);
  const [inboxSelectionPending, setInboxSelectionPending] = useState(false), [handledInboxLocation, setHandledInboxLocation] = useState<string | undefined>();
  const inFlightInboxLocation = useRef<{ readonly key: string; readonly token: symbol } | undefined>(undefined);
  const running = useRef(false), mounted = useRef(true), controller = useRef<AbortController | undefined>(undefined);
  const read = () => client.getQueryData<StudioMemory>(memoryKey) ?? {};
  const write = (update: (old: StudioMemory) => StudioMemory) => {
    if (privacy.isCurrent(context)) client.setQueryData<StudioMemory>(memoryKey, old => update(old ?? {}));
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; controller.current?.abort();
      if (running.current && privacy.isCurrent(context)) client.setQueryData<StudioMemory>(memoryKey, old =>
        old?.intent ? { ...old, intent: { ...old.intent, phase: 'unknown' } } : old);
    };
  }, [client, context, privacy]);
  const run = (action: (signal: AbortSignal) => Promise<void>) => {
    if (running.current || !privacy.isCurrent(context)) return;
    running.current = true; controller.current = new AbortController(); setBusy(true);
    const signal = controller.current.signal;
    // A refusal that was already classified and recorded by the owning action is never downgraded
    // back to an unknown outcome by this outer catch.
    void action(signal).catch(() => write(old => old.intent && old.intent.phase !== 'rejected'
      ? { ...old, intent: { ...old.intent, phase: 'unknown' } } : old))
      .finally(() => { running.current = false; if (mounted.current) setBusy(false); });
  };
  const execute = async (intent: StudioIntent, signal: AbortSignal) => {
    if (intent.kind === 'publish') {
      let result: WikiPublicationView;
      try {
        result = await runProtectedRead(privacy, context, signal, readSignal => apis.studio.publish.publishWikiProposal(
          intent.base.proposal_ref, intent.base.page.page_ref, intent.expectedHead, intent.key, context.deploymentGeneration, readSignal));
      } catch (error) {
        // Only a definitive pre-effect refusal from the publish call itself clears the intent. A
        // WIKI_HEAD_CONFLICT is deliberately not one of those, because the same code is raised
        // before and after the durable immutable write on the publish path, so writing
        // WIKI_HEAD_CONFLICT here would drop the owner's request identity on evidence that cannot
        // prove the publication never happened.
        const refused = isWorkspaceRequestError(error) && classifyMutationOutcome({
          operation: 'wiki.publish', code: error.code, status: error.status, dispatched: true,
        }).clearsIntent;
        if (!refused) throw error;
        write(old => old.intent?.key === intent.key ? { ...old, intent: { ...intent, phase: 'rejected' } } : old);
        return;
      }
      // A canonical publication receipt closes the mutation intent. Keep the receipt tied to its
      // exact proposal while the follow-up read confirms or reports lag; the receipt itself keeps
      // this proposal from exposing another publish action.
      write(old => {
        if (old.intent?.key !== intent.key) return old;
        const { intent: _intent, ...rest } = old;
        return { ...rest, published: result, publishedProposalRef: intent.base.proposal_ref };
      });
      try {
        await client.fetchQuery(options.proposal(intent.base.proposal_ref));
      } catch {
        // The protected proposal query owns this read failure and its read-only retry. It must never
        // be reclassified as a mutation failure, because the publication already succeeded and
        // re-running publish could duplicate the durable effect.
      }
      void proposals.refetch();
      return;
    }
    try {
      const result = await runProtectedRead(privacy, context, signal, readSignal => apis.studio.create.createWikiEditProposal(
        intent.base.proposal_ref, intent.base.page.page_ref, intent.base.page.page_ref.revision, intent.title,
        intent.body, intent.note, context.deploymentGeneration, intent.key, readSignal));
      write(old => { const { intent: _intent, ...rest } = old; return { ...rest, selected: result.proposal_ref, edited: result }; });
    } catch (error) {
      const refused = isWorkspaceRequestError(error) && classifyMutationOutcome({
        operation: 'wiki.propose', code: error.code, status: error.status, dispatched: true,
      }).clearsIntent;
      if (!refused) throw error;
      write(old => old.intent?.key === intent.key ? { ...old, intent: { ...intent, phase: 'rejected' } } : old);
      return;
    }
    void proposals.refetch();
  };
  const currentView = () => privacy.isCurrent(context) && view && !selected.isError && !selected.isFetching &&
    client.getQueryData(proposalKey) === view ? view : undefined;
  // A publication receipt counts for the current selection only while the session context is
  // current, the receipt is PUBLISHED for this deployment generation, and its stored proposal
  // reference is exactly the selected one. Anything else is a foreign receipt that must not
  // suppress a legitimate publication of the current draft.
  const findSelectedPublicationReceipt = (state: StudioMemory) => {
    const receipt = state.published, selectedRef = state.selected, receiptProposalRef = state.publishedProposalRef;
    if (!privacy.isCurrent(context) || !receipt || receipt.status !== 'PUBLISHED' ||
      receipt.deployment_generation !== context.deploymentGeneration || !selectedRef || !receiptProposalRef ||
      !sameRef(receiptProposalRef, selectedRef)) return undefined;
    return { proposalRef: selectedRef, receipt };
  };
  const publicationReceiptForSelected = findSelectedPublicationReceipt(memory.data ?? {});
  const publicationForSelected = publicationReceiptForSelected !== undefined;
  let expectedPublishHead: number | undefined;
  if (!publicationForSelected && view?.state === 'PROPOSED' && view.page.status === 'DRAFT') {
    try { expectedPublishHead = apis.studio.publish.expectedWikiHeadRevision(view.page); } catch { expectedPublishHead = undefined; }
  }
  const reconcile = () => {
    const intent = read().intent; if (!intent || intent.phase === 'pending') return;
    run(async signal => {
      if (intent.kind === 'publish') {
        const fresh = await client.fetchQuery(options.proposal(intent.base.proposal_ref));
        if (signal.aborted || !privacy.isCurrent(context) || !sameRef(fresh.proposal_ref, intent.base.proposal_ref) ||
            !sameRef(fresh.page.page_ref, intent.base.page.page_ref)) return;
        if (fresh.state === 'PUBLISHED') {
          write(old => { const { intent: _intent, ...rest } = old; return rest; }); return;
        }
        // An acknowledged publication is recovered by reads only, even if canonical readback lags.
        const acknowledged = read();
        if (acknowledged.published && acknowledged.publishedProposalRef &&
            sameRef(acknowledged.publishedProposalRef, intent.base.proposal_ref)) return;
      } else {
        await client.fetchQuery(options.proposals());
        if (signal.aborted || !privacy.isCurrent(context)) return;
      }
      // No new base, body, compare-and-swap target or request key is chosen during recovery.
      await execute(intent, signal);
    });
  };
  const routeSelectionActive = hasInboxStudioSelectionState(location.state) && handledInboxLocation !== location.key;
  const saved = memory.data, blocked = busy || inboxSelectionPending || routeSelectionActive || saved?.intent !== undefined;
  // Confirmed publication, unconfirmed readback. The receipt itself is trusted; what is unknown is
  // whether the published page reads back as PUBLISHED for this exact proposal and page reference.
  const publicationReadbackFailed = publicationReceiptForSelected !== undefined && (
    selected.isError || (view !== undefined && (view.state !== 'PUBLISHED' ||
      !sameRef(view.proposal_ref, publicationReceiptForSelected.proposalRef) ||
      !sameRef(view.page.page_ref, publicationReceiptForSelected.receipt.page_ref))));
  const refusedText = locale === 'ru' ? 'Действие отклонено до выполнения. Прочитайте текущий черновик перед продолжением.'
    : 'The action was refused before execution. Read the current draft before continuing.';
  // Recovery after a refusal re-reads the current draft on the same protected query, then restores
  // the owner's edit inputs from the refused intent, so the refusal never discards typed text.
  const reviewRefusal = () => {
    const held = read().intent; if (!held || held.phase !== 'rejected') return;
    run(async signal => {
      const fresh = await client.fetchQuery(options.proposal(held.base.proposal_ref));
      if (signal.aborted || !privacy.isCurrent(context) || !sameRef(fresh.proposal_ref, held.base.proposal_ref)) return;
      write(old => {
        if (old.intent?.key !== held.key || old.intent.phase !== 'rejected') return old;
        const { intent: _intent, ...rest } = old;
        return { ...rest, selected: fresh.proposal_ref, ...(held.kind === 'edit' ? { reviewedEdit: held } : {}) };
      });
    });
  };
  const savedEdit = saved?.intent?.kind === 'edit' ? saved.intent : saved?.reviewedEdit;
  const initialEdit = view && savedEdit && sameRef(savedEdit.base.proposal_ref, view.proposal_ref)
    ? { title: savedEdit.title, bodyText: savedEdit.body, editNote: savedEdit.note } : undefined;
  const reportsHeading = useRef<HTMLHeadingElement>(null), returningFromReport = useRef(false);
  const libraryHeading = useRef<HTMLHeadingElement>(null), readerHeading = useRef<HTMLHeadingElement>(null);
  const pendingProposalFocus = useRef<{ readonly context: SessionContext; readonly target: VersionedRef | 'library' } | undefined>(undefined);
  useEffect(() => {
    if (!hasInboxStudioSelectionState(location.state)) {
      if (handledInboxLocation !== undefined) setHandledInboxLocation(undefined);
      setInboxSelectionPending(false);
      setInboxSelectionFailed(false);
      return;
    }
    const routeKey = location.key;
    if (handledInboxLocation === routeKey || inFlightInboxLocation.current?.key === routeKey) return;
    if (!privacy.isCurrent(context) || proposals.isError || !proposals.data) {
      setInboxSelectionPending(false);
      return;
    }

    const proposalQueries = studioQueryOptions(apis.studio, privacy, context, () => undefined);
    const proposalListQuery = proposalQueries.proposals();
    const proposalSnapshot = proposals.data;
    if (client.getQueryData(proposalListQuery.queryKey) !== proposalSnapshot) return;
    const existingIntent = client.getQueryData<StudioMemory>(memoryKey)?.intent;
    const selection = resolveInboxStudioSelection(location.state, context, proposalSnapshot, existingIntent);
    if (!selection) {
      setHandledInboxLocation(routeKey);
      setInboxSelectionPending(false);
      if (!existingIntent && privacy.isCurrent(context)) setInboxSelectionFailed(true);
      return;
    }

    setInboxSelectionFailed(false);
    setInboxSelectionPending(true);
    const token = Symbol('inbox-studio-selection');
    inFlightInboxLocation.current = { key: routeKey, token };
    let active = true;
    void client.fetchQuery(proposalQueries.proposal(selection.proposalRef)).then(proposal => {
      if (!active || !privacy.isCurrent(context)) return;
      if (client.getQueryData<StudioMemory>(memoryKey)?.intent) {
        setInboxSelectionPending(false);
        setHandledInboxLocation(routeKey);
        return;
      }
      if (client.getQueryData(proposalListQuery.queryKey) !== proposalSnapshot ||
        !matchesInboxStudioReadback(selection, context, proposal)) {
        setInboxSelectionFailed(true);
        setInboxSelectionPending(false);
        setHandledInboxLocation(routeKey);
        return;
      }

      let applied = false;
      client.setQueryData<StudioMemory>(memoryKey, old => {
        if (!privacy.isCurrent(context) || old?.intent) return old;
        const { artifact: _artifact, ...rest } = old ?? {};
        applied = true;
        return { ...rest, selected: proposal.proposal_ref };
      });
      if (applied) {
        pendingProposalFocus.current = { context, target: proposal.proposal_ref };
        setInboxSelectionFailed(false);
      } else if (privacy.isCurrent(context) && !client.getQueryData<StudioMemory>(memoryKey)?.intent) {
        setInboxSelectionFailed(true);
      }
      setInboxSelectionPending(false);
      setHandledInboxLocation(routeKey);
    }).catch(() => {
      if (active && privacy.isCurrent(context) && !client.getQueryData<StudioMemory>(memoryKey)?.intent) {
        setInboxSelectionFailed(true);
      }
      if (active) setInboxSelectionPending(false);
    }).finally(() => {
      if (inFlightInboxLocation.current?.token === token) inFlightInboxLocation.current = undefined;
      if (active) {
        setInboxSelectionPending(false);
        if (privacy.isCurrent(context)) setHandledInboxLocation(routeKey);
      }
    });
    return () => {
      active = false;
      if (inFlightInboxLocation.current?.token === token) inFlightInboxLocation.current = undefined;
    };
  }, [apis.studio, client, context, handledInboxLocation, location.key, location.state, memory.data?.intent, memoryKey, privacy, proposals.data, proposals.isError]);
  useLayoutEffect(() => {
    if (!saved?.artifact && returningFromReport.current) {
      returningFromReport.current = false;
      reportsHeading.current?.focus();
    }
  }, [saved?.artifact]);
  useLayoutEffect(() => {
    const pending = pendingProposalFocus.current;
    if (pending === undefined) return;
    if (pending.context !== context || !privacy.isCurrent(context) || saved?.artifact) {
      pendingProposalFocus.current = undefined;
      return;
    }
    const requested = pending.target;
    if (requested === 'library') {
      if (saved?.selected !== undefined || !libraryHeading.current) return;
      libraryHeading.current.focus();
    } else {
      if (!view || !saved?.selected || selected.isError || selected.isFetching ||
        !sameRef(requested, saved.selected) || !sameRef(requested, view.proposal_ref) ||
        client.getQueryData(proposalKey) !== view || !readerHeading.current) return;
      readerHeading.current.focus();
    }
    pendingProposalFocus.current = undefined;
  }, [client, context, privacy, proposalKey, saved?.artifact, saved?.selected, selected.isError, selected.isFetching, view]);
  const displayTime = (iso: string) => {
    const date = new Date(iso);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date) : iso;
  };
  const featureCopy = { ...STUDIO_COPY[locale], title: text.drafts };
  const currentProposals = proposals.data && !proposals.isError ? { ...proposals.data,
    items: proposals.data.items.map(proposal => view && sameRef(proposal.proposal_ref, view.proposal_ref)
      ? { ...proposal, state: view.state } : proposal),
  } : undefined;
  const announcement = usePaneAnnouncement(inboxSelectionPending ? text.reading : busy ? text.working
    : saved?.intent?.phase === 'unknown' ? text.unknown
    : saved?.intent?.phase === 'rejected' ? refusedText
    : publicationReadbackFailed ? readbackText.failed
    : selected.isError || body.isError ? text.failed
    : proposals.isError ? featureCopy.error
    : history.isError ? reportText.failed
    : selected.isFetching || body.isFetching || proposals.isFetching || history.isPending || history.isFetching ? text.reading
    : view?.state === 'PUBLISHED' || publicationForSelected ? text.published
    : view && saved?.edited && sameRef(view.proposal_ref, saved.edited.proposal_ref) ? text.edited : proposals.data ? text.loaded : '');
  if (saved?.artifact && !routeSelectionActive && !inboxSelectionFailed) return <ReportPanel key={`${saved.artifact.id}:${saved.artifact.revision}`} locale={locale} apis={apis} privacy={privacy} context={context} artifactRef={saved.artifact}
    onOpenDraft={artifact => write(old => ({ ...old, artifact }))}
    onClose={() => { if (privacy.isCurrent(context)) { returningFromReport.current = true; write(old => { const { artifact: _artifact, ...rest } = old; return rest; }); } }} />;
  return <>
    <OperationAnnouncement>{announcement}</OperationAnnouncement>
    {inboxSelectionFailed ? <Status tone="error">{inboxSelectionCopy[locale]}</Status> : null}
    <div className="er-live-actions"><Button variant="text" disabled={proposals.isFetching || busy} onClick={() => { void proposals.refetch(); void history.refetch(); }}>{text.read}</Button></div>
    {saved?.intent?.phase === 'unknown' && <div><Status>{text.unknown}</Status><Button variant="tonal" disabled={busy} onClick={reconcile}>{text.recover}</Button></div>}
    {saved?.intent?.phase === 'rejected' && <div><Status tone="error">{refusedText}</Status><Button variant="text" disabled={busy} onClick={reviewRefusal}>{text.review}</Button></div>}
    {(view?.state === 'PUBLISHED' || publicationForSelected) && <Status>{text.published}</Status>}
    {view && view.state !== 'PUBLISHED' && saved?.edited && sameRef(view.proposal_ref, saved.edited.proposal_ref) && <Status>{text.edited}</Status>}
    {publicationReadbackFailed ? <div><Status tone="error">{readbackText.failed}</Status><Button variant="tonal" disabled={busy || selected.isFetching} onClick={() => { void selected.refetch(); }}>{readbackText.retry}</Button></div>
      : selected.isError || body.isError ? <div><Status tone="error">{text.failed}</Status><Button variant="tonal" disabled={selected.isFetching || body.isFetching} onClick={() => { void selected.refetch(); if (view) void body.refetch(); }}>{text.reread}</Button></div> : null}
    <section className="er-live-history" aria-label={text.recent}>
      <div className="er-live-history-heading"><h2 ref={reportsHeading} tabIndex={-1}>{text.recent}</h2>
        {history.isError ? <Button variant="text" disabled={history.isFetching} onClick={() => { void history.refetch(); }}>{reportText.refresh}</Button> : null}</div>
      {history.isError ? <Status tone="error">{reportText.failed}</Status>
        : history.isPending || history.isFetching ? <Status>{reportText.reading}</Status>
        : history.data?.saved_drafts.length === 0 ? <p>{reportText.empty}</p> : null}
      <ul>{!history.isError && history.data?.saved_drafts.map(draft => <li key={`${draft.artifact_ref.id}:${draft.artifact_ref.revision}`}>
      <time dateTime={draft.created_at}>{displayTime(draft.created_at)}</time><Button variant="tonal" onClick={() => write(old => ({ ...old, artifact: draft.artifact_ref }))}>{text.report}</Button>
      </li>)}</ul>
    </section>
    <fieldset className="er-live-plain-fieldset" disabled={blocked} aria-label={text.drafts}>
      <StudioFeature key={view ? `${view.proposal_ref.id}:${view.proposal_ref.revision}` : 'list'} locale={locale} copy={featureCopy}
        {...(initialEdit ? { initialEdit } : {})}
        state={proposals.isPending ? 'loading' : proposals.isError ? 'error' : !proposals.data?.items.length ? 'empty' : 'useful'}
        libraryHeadingRef={libraryHeading} readerHeadingRef={readerHeading}
        bodyLoading={view !== undefined && (body.isPending || body.isFetching) && (body.data === undefined || body.isError)}
        {...(currentProposals ? { proposals: currentProposals } : {})}
        {...(view ? { selected: view } : {})}
        {...(body.data && !body.isError && !selected.isError ? { body: body.data } : {})}
        {...(expectedPublishHead !== undefined && !body.isError && body.data ? { expectedPublishHead } : {})}
        cowVerified={expectedPublishHead !== undefined && body.data !== undefined && !body.isError && view !== undefined && body.data.body_sha256 === view.page.body_sha256}
        onOpenProposal={summary => {
          if (privacy.isCurrent(context) && client.getQueryData(options.proposals().queryKey) === proposals.data &&
            proposals.data?.items.some(row => sameRef(row.proposal_ref, summary.proposal_ref))) {
            pendingProposalFocus.current = { context, target: summary.proposal_ref };
            write(old => ({ ...old, selected: summary.proposal_ref }));
          }
        }}
        onCreateEdit={input => {
          const base = currentView();
          if (!base || read().intent || running.current || !body.data || body.isError ||
            !sameRef(input.baseProposalRef, base.proposal_ref) || !sameRef(input.basePageRef, base.page.page_ref) ||
            input.expectedHeadRevision !== base.page.page_ref.revision || !input.title.trim() || !input.bodyText.trim()) return;
          const intent: StudioIntent = Object.freeze({ kind: 'edit', base, title: input.title, body: input.bodyText,
            note: input.editNote, key: apis.sources.mintIntent(), phase: 'pending' });
          write(old => ({ ...old, intent })); run(signal => execute(intent, signal));
        }}
        onPublish={input => {
          const base = currentView(), currentState = read();
          if (!base || findSelectedPublicationReceipt(currentState) !== undefined || currentState.intent || running.current ||
            expectedPublishHead === undefined || !body.data || body.isError ||
            !sameRef(input.proposalRef, base.proposal_ref) || !sameRef(input.pageRef, base.page.page_ref) ||
            input.expectedHeadRevision !== expectedPublishHead) return;
          const intent: StudioIntent = Object.freeze({ kind: 'publish', base, expectedHead: expectedPublishHead,
            key: apis.sources.mintIntent(), phase: 'pending' });
          write(old => ({ ...old, intent })); run(signal => execute(intent, signal));
        }}
        onBack={() => {
          if (!privacy.isCurrent(context)) return;
          pendingProposalFocus.current = { context, target: 'library' };
          write(old => { const { selected: _selected, ...rest } = old; return rest; });
        }} />
    </fieldset>
  </>;
}
