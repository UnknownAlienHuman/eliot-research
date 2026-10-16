import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { skipToken, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, EvidenceFeature, ReportFeature, REPORT_COPY, SafeMarkdown, Status } from '@eliotr/ui';
import { assembleResearchDraftMarkdown, type ArtifactRevisionRead, type ArtifactSectionResponse,
  type CitedEvidence, type DeclaredSection, type ResearchArtifactDraftReauthorizationView,
  type ReauthorizedCitedEvidence, type VerifiedEvidence, type VersionedRef } from '@eliotr/owner-api-client';
import { isWorkspaceRequestError, type BoundWorkspaceApis } from './runtime';
import type { PrivacyController, SessionContext } from './privacy';
import { reportQueryOptions } from '../query/reports';
import { protectedQueryKey } from '../query/client';
import { OperationFeedback } from './OperationFeedback';
import { ArtifactActions } from './ArtifactActions';

const refKey = (ref: VersionedRef) => `${ref.id}:${ref.revision}`;
const sameRef = (left: VersionedRef, right: VersionedRef) => left.id === right.id && left.revision === right.revision;
const copy = {
  en: { readingCitations: 'Reading citations for this section.', readingReport: 'Reading the saved report.', reportReady: 'Saved report loaded.', sectionReady: 'The selected section was read and verified.', readingEvidence: 'Reading the selected cited excerpt.', evidenceReady: 'The selected cited excerpt was verified.', title: 'Saved report', back: 'Close report', outline: 'Contents', backToSections: 'Back to the report', read: 'Refresh', reauthorize: 'Read with current access', access: 'Read with your current access. The report keeps its original sources.', evidence: 'Evidence for this section', quotes: 'Quotes and sources', method: 'How it was researched', exportShort: 'Export', document: 'Report text', pending: 'Reading this section…', noAudit: 'Claims in this section were not checked against the sources.', unknown: 'This section could not be read or verified.', legacyRead: 'This report response has no section titles. Refresh after the application updates.', exportError: 'The export could not be prepared. Read all sections again.', reading: 'Reading the selected section.', noEvidence: 'No citations are declared for this section.', evidenceError: 'This quote could not be verified against its source.' },
  ru: { readingCitations: 'Читаем цитаты для этого раздела.', readingReport: 'Читаем сохранённый отчёт.', reportReady: 'Сохранённый отчёт прочитан.', sectionReady: 'Выбранный раздел прочитан и проверен.', readingEvidence: 'Читаем цитату.', evidenceReady: 'Цитата сверена с источником.', title: 'Сохранённый отчёт', back: 'Закрыть отчёт', outline: 'Содержание', backToSections: 'Назад к отчёту', read: 'Обновить', reauthorize: 'Прочитать с текущим доступом', access: 'Чтение с вашим текущим доступом. Источники отчёта остаются прежними.', evidence: 'Доказательства этого раздела', quotes: 'Цитаты и источники', method: 'Как проводилось исследование', exportShort: 'Экспорт', document: 'Текст отчёта', pending: 'Читаем раздел…', noAudit: 'Утверждения этого раздела не проверялись по источникам.', unknown: 'Не удалось прочитать или проверить этот раздел.', legacyRead: 'В этом ответе нет названий разделов. Обновите приложение и повторите чтение.', exportError: 'Не удалось подготовить экспорт. Прочитайте все разделы ещё раз.', reading: 'Читаем выбранный раздел.', noEvidence: 'Для этого раздела не объявлены цитаты.', evidenceError: 'Не удалось сверить эту цитату с источником.' },
} as const;

/**
 * The draft writer appends a "Coverage and method" part (scope, encountered and cited revisions, limits).
 * It is the record of how the answer was found, not the answer: it stays one tap away, folded.
 */
const METHOD_HEADING = /^#{1,3}[ \t]+(?:Coverage and method|Охват и метод)[ \t]*$/mu;
function StatementChecks({ labels, locale }: {
  readonly labels: ArtifactRevisionRead['sections'][number]['statement_labels']; readonly locale: 'en' | 'ru';
}) {
  const names = locale === 'ru' ? {
    SOURCE_SUPPORTED: 'Подтверждены источниками', DERIVED_INFERENCE: 'Выводы на основе источников',
    HYPOTHESIS: 'Гипотезы', CONTESTED: 'Оспариваются', UNRESOLVED: 'Не удалось проверить по доступным источникам',
    EDITORIAL_RECOMMENDATION: 'Редакционные рекомендации', REDACTED_DEPENDENCY: 'Зависят от недоступных данных',
  } : {
    SOURCE_SUPPORTED: 'Supported by sources', DERIVED_INFERENCE: 'Inferences from sources',
    HYPOTHESIS: 'Hypotheses', CONTESTED: 'Contested', UNRESOLVED: 'Could not be verified from available sources',
    EDITORIAL_RECOMMENDATION: 'Editorial recommendations', REDACTED_DEPENDENCY: 'Depend on unavailable evidence',
  };
  const values = Object.values(labels);
  if (values.length === 0) return null;
  const counts = (Object.keys(names) as (keyof typeof names)[]).flatMap(label => {
    const count = values.filter(value => value === label).length;
    return count === 0 ? [] : [`${names[label]}: ${count}`];
  });
  return <p className="er-shell-note" role="note">{locale === 'ru' ? 'Сохранённая проверка утверждений. ' : 'Saved statement checks. '}{counts.join('; ')}.</p>;
}

function ReportMarkdown({ body, method, locale }: { readonly body: string; readonly method: string; readonly locale: 'en' | 'ru' }) {
  const match = METHOD_HEADING.exec(body);
  if (match === null) return <SafeMarkdown text={body} />;
  const answer = body.slice(0, match.index).trimEnd(), record = body.slice(match.index + match[0].length).trim();
  const counts = /Evidence uses (\d+) sources; (\d+) sources are cited\./u.exec(record)
    ?? /В доказательствах использовано источников: (\d+); процитировано: (\d+)\./u.exec(record);
  const sampled = /Coverage is sampled|Охват выборочный/u.test(record);
  const localizedRecord = counts === null ? record : locale === 'ru'
    ? `В доказательствах использовано источников: ${counts[1]}; процитировано: ${counts[2]}.\n\n${sampled ? 'Охват выборочный; полнота корпуса не установлена.' : 'Область исследования зафиксирована.'} Метод и ограничения сохранены в квитанции охвата.`
    : `Evidence uses ${counts[1]} sources; ${counts[2]} sources are cited.\n\n${sampled ? 'Coverage is sampled; corpus completeness is not established.' : 'The research scope is fixed.'} The coverage receipt retains the method and limitations.`;
  return <>
    {answer ? <SafeMarkdown text={answer} /> : null}
    {record ? <details className="er-live-report-method"><summary>{method}</summary><SafeMarkdown text={localizedRecord} /></details> : null}
  </>;
}

/** One requested section at a time. Exact verified bytes remain in protected memory-only Query. */
export function ReportPanel({ apis, privacy, context, locale, artifactRef, onClose, onOpenDraft }: {
  readonly apis: BoundWorkspaceApis; readonly privacy: PrivacyController; readonly context: SessionContext;
  readonly locale: 'en' | 'ru'; readonly artifactRef: VersionedRef; readonly onClose: () => void;
  readonly onOpenDraft: (ref: VersionedRef) => void;
}) {
  const client = useQueryClient(), text = copy[locale];
  const [mode, setMode] = useState<'author' | 'reauthorized'>('author');
  let manifestKey: readonly unknown[] = [];
  const currentArtifact = () => {
    if (!privacy.isCurrent(context) || client.getQueryState(manifestKey)?.status !== 'success' ||
      client.getQueryState(manifestKey)?.fetchStatus === 'fetching') return undefined;
    if (mode === 'author') return client.getQueryData<ArtifactRevisionRead>(manifestKey);
    const reauthorized = client.getQueryData<ResearchArtifactDraftReauthorizationView>(manifestKey);
    return reauthorized?.protocol === 'eliotr.artifact-draft-reauthorization.v3' ? reauthorized.artifact : undefined;
  };
  const options = reportQueryOptions(apis, privacy, context, currentArtifact);
  const authorOptions = options.manifest(artifactRef), grantedOptions = options.reauthorizedManifest(artifactRef);
  manifestKey = mode === 'author' ? authorOptions.queryKey : grantedOptions.queryKey;
  const author = useQuery(mode === 'author' ? authorOptions : { queryKey: authorOptions.queryKey, queryFn: skipToken });
  const granted = useQuery(mode === 'reauthorized' ? grantedOptions : { queryKey: grantedOptions.queryKey, queryFn: skipToken });
  const manifest = mode === 'author' ? author : granted;
  const grant = mode === 'reauthorized' && !granted.isError &&
    granted.data?.protocol === 'eliotr.artifact-draft-reauthorization.v3' ? granted.data : undefined;
  const unsupportedLegacyRead = mode === 'reauthorized' && granted.data !== undefined && grant === undefined;
  const artifact = mode === 'author' ? author.isError ? undefined : author.data : grant?.artifact;
  const [selected, setSelected] = useState<DeclaredSection>();
  const [picked, setPicked] = useState<CitedEvidence | ReauthorizedCitedEvidence>();
  const [exportError, setExportError] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [sectionActivation, setSectionActivation] = useState(0);
  // Opening a saved report is already a read intent. Expired original grants
  // are renewed through the server's historical reader without another click.
  useEffect(() => {
    if (mode !== 'author' || !author.isError || !privacy.isCurrent(context) ||
        !isWorkspaceRequestError(author.error) ||
        !['ARTIFACT_DRAFT_READ_STALE', 'ARTIFACT_DRAFT_READ_DENIED'].includes(author.error.code)) return;
    setSelected(undefined); setPicked(undefined); setExportError(false); setMode('reauthorized');
  }, [mode, author.isError, author.error, privacy, context]);
  const outlineSummary = useRef<HTMLElement>(null);
  const reportHeading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { reportHeading.current?.focus(); }, [mode]);
  const sectionHeading = useRef<HTMLHeadingElement>(null);
  const active = artifact?.sections.find(row => selected && sameRef(row.section_ref, selected.section_ref) &&
    row.body_object_ref === selected.body_object_ref && row.body_sha256 === selected.body_sha256);
  const activeRef = active ? refKey(active.section_ref) : undefined;
  useEffect(() => { if (activeRef) sectionHeading.current?.focus(); }, [activeRef, sectionActivation]);
  useEffect(() => {
    if (activeRef === undefined) setOutlineOpen(true);
  }, [activeRef, manifest.status, manifest.isFetching]);
  const sectionOptions = (held: ArtifactRevisionRead, declared: DeclaredSection) => grant
    ? options.reauthorizedSection(grant, declared) : options.section(held, declared);
  // Verified bytes of an admitted revision never go stale; only an explicit refetch reads them again.
  const section = useQuery(artifact && active ? { ...sectionOptions(artifact, active), gcTime: Infinity, staleTime: Infinity }
    : { queryKey: [...protectedQueryKey(context, 'report'), 'section-unselected'], queryFn: skipToken });
  const authorCitations = useQuery(mode === 'author' && artifact && active && section.data && !section.isError ? { ...options.citations(artifact, active), gcTime: Infinity }
    : { queryKey: [...protectedQueryKey(context, 'report'), 'citations-unselected'], queryFn: skipToken });
  const grantedCitations = useQuery(grant && active && section.data && !section.isError ? { ...options.reauthorizedCitations(grant, active), gcTime: Infinity }
    : { queryKey: [...protectedQueryKey(context, 'report'), 'reauthorized-citations-unselected'], queryFn: skipToken });
  const citations = mode === 'author' ? authorCitations : grantedCitations;
  const currentCitation = citations.data?.cited_evidence.find(row => picked && sameRef(row.handle_ref, picked.handle_ref) && row.excerpt_sha256 === picked.excerpt_sha256);
  const evidenceScope = mode === 'author' ? authorCitations.data?.scope_snapshot_ref
    : grantedCitations.data?.authorization_scope_snapshot_ref;
  const evidence = useQuery(artifact && section.data && !section.isError && currentCitation && evidenceScope && !citations.isError ? {
    ...options.evidence(evidenceScope, currentCitation), gcTime: Infinity,
  } : { queryKey: [...protectedQueryKey(context, 'report'), 'evidence-unselected'], queryFn: skipToken });
  // The report reads itself: each declared section is fetched and verified in order, one at a time,
  // through the same exact section read a click would make; a failed section stops the ones after it.
  const declaredSections = artifact?.sections ?? [];
  const settled = (index: number) => artifact !== undefined && declaredSections.slice(0, index).every(previous =>
    client.getQueryState(sectionOptions(artifact, previous).queryKey)?.status === 'success');
  const documentReads = useQueries({ queries: declaredSections.map((declared, index) => artifact && settled(index)
    ? { ...sectionOptions(artifact, declared), gcTime: Infinity, staleTime: Infinity }
    : { queryKey: [...protectedQueryKey(context, 'report'), 'document-pending', refKey(declared.section_ref)], queryFn: skipToken }) });
  const documentText = (declared: DeclaredSection, index: number) => {
    const read = documentReads[index]?.data as ArtifactSectionResponse | undefined;
    if (read === undefined || documentReads[index]?.isError || !sameRef(read.section_ref, declared.section_ref)) return undefined;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(read.bytes); } catch { return undefined; }
  };
  const single = artifact !== undefined && artifact.sections.length === 1;
  const rows = artifact?.sections.map(declared => ({ section: declared,
    read: client.getQueryState(sectionOptions(artifact, declared).queryKey)?.status === 'success'
      ? client.getQueryData<ArtifactSectionResponse>(sectionOptions(artifact, declared).queryKey) : undefined,
  })) ?? [];
  const readSection = (declared: DeclaredSection) => {
    if (!artifact || currentArtifact() !== artifact ||
      !artifact.sections.some(row => sameRef(row.section_ref, declared.section_ref) && row.body_object_ref === declared.body_object_ref && row.body_sha256 === declared.body_sha256)) return;
    setSelected(declared); setPicked(undefined); setExportError(false);
    setOutlineOpen(false);
    setSectionActivation(value => value + 1);
  };
  const exportReport = () => {
    if (!artifact || currentArtifact() !== artifact) return;
    try {
      const reads = rows.map(row => row.read);
      if (reads.some(read => read === undefined)) throw new Error('Missing required readback');
      const sections = reads.filter((read): read is ArtifactSectionResponse => read !== undefined);
      const result = assembleResearchDraftMarkdown({ artifact, artifactRef: refKey(artifactRef), sections });
      if (currentArtifact() !== artifact) return;
      const objectUrl = URL.createObjectURL(new Blob([new Uint8Array(result.bytes).buffer], { type: 'text/markdown;charset=utf-8' }));
      try {
        const link = document.createElement('a'); link.href = objectUrl; link.download = 'eliot-report.md'; link.click();
      } finally { URL.revokeObjectURL(objectUrl); }
      setExportError(false);
    } catch { setExportError(true); }
  };
  let body: string | undefined;
  if (section.data && !section.isError && active && sameRef(section.data.section_ref, active.section_ref)) {
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(section.data.bytes); } catch { body = undefined; }
  }
  const evidenceRows = !artifact || section.isError || citations.isError ? [] : citations.data?.cited_evidence.map(citation => {
    const isSelected = currentCitation !== undefined && sameRef(citation.handle_ref, currentCitation.handle_ref);
    const opened: VerifiedEvidence | undefined = evidence.isError || !isSelected || evidence.data?.excerptSha256 !== citation.excerpt_sha256 ? undefined : evidence.data;
    const audit = citations.data?.semantic_verification === 'EXECUTED' ? citations.data.audit : undefined;
    const auditHandle = 'original_handle_ref' in citation ? citation.original_handle_ref : citation.handle_ref;
    const claim = audit?.claims.find(row => [...row.support_handle_refs, ...row.counterevidence_handle_refs].some(ref => sameRef(ref, auditHandle)));
    return { citation,
      ...(claim ? { forClaim: claim, forClaimRelation: claim.support_handle_refs.some(ref => sameRef(ref, auditHandle)) ? 'support' as const : 'counterevidence' as const } : {}),
      ...(opened ? { opened, outcome: { outcome: 'RESOLVED' as const, handle_ref: opened.handleRef, excerpt_sha256: opened.excerptSha256, verification_receipt_ref: opened.verificationReceiptRef } } : {}),
      state: isSelected ? evidence.isFetching ? 'loading' as const : evidence.isError ? 'failed' as const : opened ? 'loaded' as const : 'idle' as const : 'idle' as const,
    };
  }) ?? [];
  const operationMessage = exportError ? text.exportError
    : manifest.isFetching ? text.readingReport : manifest.isError ? text.unknown
    : unsupportedLegacyRead ? text.legacyRead
    : active && section.isFetching ? text.reading
    : active && (section.isError || body === undefined) ? text.unknown
    : active && citations.isFetching ? text.readingCitations
    : active && citations.isError ? text.evidenceError
    : currentCitation && evidence.isFetching ? text.readingEvidence
    : currentCitation && evidence.isError ? text.evidenceError
    : currentCitation && evidenceRows.some(row => row.state === 'loaded' && sameRef(row.citation.handle_ref, currentCitation.handle_ref)) ? text.evidenceReady
    : active && body !== undefined ? text.sectionReady : artifact ? text.reportReady : '';
  return <section className="er-live-report" aria-label={text.title}>
    <h2 className="er-live-report-title" ref={reportHeading} tabIndex={-1}>{artifact?.title ?? text.title}</h2>
    <OperationFeedback message={operationMessage} />
    <div className="er-live-actions er-live-report-toolbar"><Button variant="text" onClick={onClose}>{text.back}</Button>
      <Button variant="text" disabled={manifest.isFetching} onClick={() => { void manifest.refetch(); }}>{text.read}</Button>
      {single && <Button variant="text" icon="send" disabled={!rows.every(row => row.read !== undefined)} onClick={exportReport}>{text.exportShort}</Button>}</div>
    {mode === 'author' && (author.isError || section.isError || citations.isError || evidence.isError) &&
      <Button variant="tonal" disabled={manifest.isFetching || !privacy.isCurrent(context)} onClick={() => {
        if (!privacy.isCurrent(context)) return;
        setSelected(undefined); setPicked(undefined); setMode('reauthorized');
      }}>{text.reauthorize}</Button>}
    {exportError && <Status tone="error">{text.exportError}</Status>}
    {!active && artifact && <section className="er-live-report-document" aria-label={text.document}>
      {declaredSections.map((declared, index) => {
        const body = documentText(declared, index), failed = documentReads[index]?.isError === true;
        return <article key={refKey(declared.section_ref)} className="er-live-report-part" aria-label={declared.title}
          data-state={body !== undefined ? 'read' : failed ? 'failed' : 'pending'}>
          <h2 className="er-live-report-part-heading">{declared.title}</h2>
          {body !== undefined ? <><StatementChecks labels={declared.statement_labels} locale={locale} /><ReportMarkdown body={body} method={text.method} locale={locale} /></>
            : failed ? <Status tone="error">{text.unknown}</Status>
              : <p className="er-live-report-pending"><span>{text.pending}</span></p>}
          {body !== undefined && <Button variant="text" icon="evidence" onClick={() => readSection(declared)}>{text.quotes}</Button>}
        </article>;
      })}
    </section>}
    {/* A one-section report needs no contents page; its export sits on the toolbar. */}
    {!single && <details className="er-live-report-outline" open={outlineOpen}
      onToggle={event => { if (event.target === event.currentTarget) setOutlineOpen(event.currentTarget.open); }}>
    <summary ref={outlineSummary}>{text.outline}</summary>
    <ReportFeature locale={locale} copy={REPORT_COPY[locale]} state={manifest.isPending ? 'loading' : manifest.isError || unsupportedLegacyRead ? 'error' : artifact ? 'useful' : 'empty'}
      {...(artifact ? { manifest: { artifact_ref: artifact.artifact_ref, title: artifact.title, created_at: artifact.created_at, sections: artifact.sections } } : {})}
      sections={rows} freshness={grant?.source_freshness.state ?? 'UNKNOWN'} onReadSection={readSection} onOpenManifest={() => { void manifest.refetch(); }} onExport={exportReport}
      {...(section.isFetching && active ? { readingRef: refKey(active.section_ref) } : {})}
      {...(section.isError && active ? { rejectedSectionRef: refKey(active.section_ref) } : {})} />
    </details>}
    {active && <section className="er-live-report-section" aria-label={active.title}>
      <h2 ref={sectionHeading} tabIndex={-1}>{active.title}</h2>
      <div className="er-live-report-layout"><div className="er-live-report-body">
      {section.isFetching ? <Status>{text.reading}</Status> : section.isError || body === undefined ? <Status tone="error">{text.unknown}</Status> : <><StatementChecks labels={active.statement_labels} locale={locale} /><ReportMarkdown body={body} method={text.method} locale={locale} /></>}
      {citations.data?.semantic_verification === 'NOT_EXECUTED' && <p className="er-shell-note">{text.noAudit}</p>}
      </div><aside className="er-live-report-evidence" aria-label={text.evidence}><EvidenceFeature citations={evidenceRows}
        loading={citations.isFetching} emptyMessage={text.noEvidence} longLocale={locale}
        {...(citations.isError ? { errorMessage: text.evidenceError } : {})}
        onOpenExcerpt={citation => {
          if (privacy.isCurrent(context) && !citations.isError && citations.data?.cited_evidence.some(row =>
            sameRef(row.handle_ref, citation.handle_ref) && row.excerpt_sha256 === citation.excerpt_sha256)) {
            if (currentCitation && sameRef(currentCitation.handle_ref, citation.handle_ref) && evidence.isError) void evidence.refetch();
            else setPicked(citation);
          }
        }}
        onRetry={() => { if (citations.isError) void citations.refetch(); else if (currentCitation) void evidence.refetch(); }} />
      </aside></div>
      <div className="er-live-actions">
        <Button variant="text" onClick={() => { setSelected(undefined); setPicked(undefined); reportHeading.current?.focus(); }}>{text.backToSections}</Button>
      </div>
    </section>}
    {mode === 'author' && artifact && <ArtifactActions apis={apis} privacy={privacy} context={context}
      locale={locale} artifact={artifact} currentArtifact={currentArtifact}
      {...(active ? { sectionId: active.contract_id } : {})}
      onOpenDraft={onOpenDraft} />}
  </section>;
}
