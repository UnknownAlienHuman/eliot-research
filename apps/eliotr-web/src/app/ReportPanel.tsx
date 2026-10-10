import { useEffect, useRef, useState } from 'react';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, EvidenceFeature, ReportFeature, REPORT_COPY, SafeMarkdown, Status } from '@eliotr/ui';
import { assembleResearchDraftMarkdown, type ArtifactRevision, type ArtifactSectionResponse,
  type CitedEvidence, type DeclaredSection, type ResearchArtifactDraftReauthorizationView,
  type ReauthorizedCitedEvidence, type VerifiedEvidence, type VersionedRef } from '@eliotr/owner-api-client';
import type { BoundWorkspaceApis } from './runtime';
import { isWorkspaceRequestError } from './runtime';
import type { PrivacyController, SessionContext } from './privacy';
import { reportQueryOptions } from '../query/reports';
import { protectedQueryKey } from '../query/client';
import { ArtifactActions } from './ArtifactActions';

const refKey = (ref: VersionedRef) => `${ref.id}:${ref.revision}`;
const sameRef = (left: VersionedRef, right: VersionedRef) => left.id === right.id && left.revision === right.revision;
const copy = {
  en: { title: 'Saved report', back: 'Close report', outline: 'Sections and export', backToSections: 'Back to sections', read: 'Read report again', reauthorize: 'Read with current access', access: 'This read uses a fresh authorization. The saved source scope is preserved.', section: (index: number) => `Section ${index + 1}`, evidence: 'Evidence for this section', noAudit: 'Semantic claim assessment was not executed for this section.', unknown: 'This section could not be read or verified.', exportError: 'A complete export could not be prepared. Read every declared section again.', reading: 'Reading the selected section.', noEvidence: 'No citations are declared for this section.', evidenceError: 'These exact evidence bytes could not be verified for the current scope.' },
  ru: { title: 'Сохранённый отчёт', back: 'Закрыть отчёт', outline: 'Разделы и экспорт', backToSections: 'К разделам отчёта', read: 'Прочитать отчёт снова', reauthorize: 'Прочитать с текущим доступом', access: 'Чтение использует новое разрешение. Сохранённая область источников остаётся прежней.', section: (index: number) => `Раздел ${index + 1}`, evidence: 'Доказательства этого раздела', noAudit: 'Семантическая оценка утверждений для этого раздела не выполнялась.', unknown: 'Не удалось прочитать или проверить этот раздел.', exportError: 'Не удалось подготовить полный экспорт. Прочитайте все объявленные разделы ещё раз.', reading: 'Читаем выбранный раздел.', noEvidence: 'Для этого раздела не объявлены цитаты.', evidenceError: 'Не удалось проверить точные байты доказательства в текущей области доступа.' },
} as const;

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
    return mode === 'author' ? client.getQueryData<ArtifactRevision>(manifestKey)
      : client.getQueryData<ResearchArtifactDraftReauthorizationView>(manifestKey)?.artifact;
  };
  const options = reportQueryOptions(apis, privacy, context, currentArtifact);
  const authorOptions = options.manifest(artifactRef), grantedOptions = options.reauthorizedManifest(artifactRef);
  manifestKey = mode === 'author' ? authorOptions.queryKey : grantedOptions.queryKey;
  const author = useQuery(mode === 'author' ? authorOptions : { queryKey: authorOptions.queryKey, queryFn: skipToken });
  const granted = useQuery(mode === 'reauthorized' ? grantedOptions : { queryKey: grantedOptions.queryKey, queryFn: skipToken });
  const manifest = mode === 'author' ? author : granted;
  const grant = mode === 'reauthorized' && !granted.isError ? granted.data : undefined;
  const artifact = mode === 'author' ? author.isError ? undefined : author.data : grant?.artifact;
  const [selected, setSelected] = useState<DeclaredSection>();
  const [picked, setPicked] = useState<CitedEvidence | ReauthorizedCitedEvidence>();
  const [exportError, setExportError] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [sectionActivation, setSectionActivation] = useState(0);
  const outlineSummary = useRef<HTMLElement>(null);
  const sectionHeading = useRef<HTMLHeadingElement>(null);
  const active = artifact?.sections.find(row => selected && sameRef(row.section_ref, selected.section_ref) &&
    row.body_object_ref === selected.body_object_ref && row.body_sha256 === selected.body_sha256);
  const activeRef = active ? refKey(active.section_ref) : undefined;
  useEffect(() => { if (activeRef) sectionHeading.current?.focus(); }, [activeRef, sectionActivation]);
  useEffect(() => {
    if (activeRef === undefined) setOutlineOpen(true);
  }, [activeRef, manifest.status, manifest.isFetching]);
  const sectionOptions = (held: ArtifactRevision, declared: DeclaredSection) => grant
    ? options.reauthorizedSection(grant, declared) : options.section(held, declared);
  const section = useQuery(artifact && active ? { ...sectionOptions(artifact, active), gcTime: Infinity }
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
  return <section className="er-live-report" aria-label={text.title}>
    <div className="er-live-actions"><Button variant="text" onClick={onClose}>{text.back}</Button>
      <Button variant="tonal" disabled={manifest.isFetching} onClick={() => { void manifest.refetch(); }}>{text.read}</Button></div>
    {mode === 'author' && isWorkspaceRequestError(author.error) && author.error.status === 404 && author.error.code === 'ARTIFACT_DRAFT_READ_NOT_FOUND' &&
      <Button variant="tonal" onClick={() => { setSelected(undefined); setPicked(undefined); setMode('reauthorized'); }}>{text.reauthorize}</Button>}
    {grant && <p>{text.access}</p>}
    <details className="er-live-report-outline" open={outlineOpen}
      onToggle={event => { if (event.target === event.currentTarget) setOutlineOpen(event.currentTarget.open); }}>
    <summary ref={outlineSummary}>{text.outline}</summary>
    <ReportFeature locale={locale} copy={REPORT_COPY[locale]} state={manifest.isPending ? 'loading' : manifest.isError ? 'error' : artifact ? 'useful' : 'empty'}
      {...(artifact ? { manifest: { artifact_ref: artifact.artifact_ref, title: text.title, created_at: artifact.created_at, sections: artifact.sections } } : {})}
      sections={rows} freshness={grant?.source_freshness.state ?? 'UNKNOWN'} onReadSection={readSection} onOpenManifest={() => { void manifest.refetch(); }} onExport={exportReport}
      {...(section.isFetching && active ? { readingRef: refKey(active.section_ref) } : {})}
      {...(section.isError && active ? { rejectedSectionRef: refKey(active.section_ref) } : {})} />
    </details>
    {exportError && <Status tone="error">{text.exportError}</Status>}
    {active && <section className="er-live-report-section" aria-label={text.section(artifact?.sections.findIndex(row => sameRef(row.section_ref, active.section_ref)) ?? 0)}>
      <h2 ref={sectionHeading} tabIndex={-1}>{text.section(artifact?.sections.findIndex(row => sameRef(row.section_ref, active.section_ref)) ?? 0)}</h2>
      {section.isFetching ? <Status>{text.reading}</Status> : section.isError || body === undefined ? <Status tone="error">{text.unknown}</Status> : <SafeMarkdown text={body} />}
      {citations.data?.semantic_verification === 'NOT_EXECUTED' && <p>{text.noAudit}</p>}
      <h3>{text.evidence}</h3><EvidenceFeature citations={evidenceRows}
        loading={citations.isFetching} emptyMessage={text.noEvidence} longLocale={locale}
        {...(citations.isError || evidence.isError ? { errorMessage: text.evidenceError } : {})}
        onOpenExcerpt={citation => { if (privacy.isCurrent(context) && !citations.isError && citations.data?.cited_evidence.some(row => sameRef(row.handle_ref, citation.handle_ref) && row.excerpt_sha256 === citation.excerpt_sha256)) setPicked(citation); }}
        onRetry={() => { if (citations.isError) void citations.refetch(); else if (currentCitation) void evidence.refetch(); }} />
      <div className="er-live-actions">
        <Button variant="text" onClick={() => { setOutlineOpen(true); outlineSummary.current?.focus(); }}>{text.backToSections}</Button>
      </div>
    </section>}
    {mode === 'author' && artifact && <ArtifactActions apis={apis} privacy={privacy} context={context}
      locale={locale} artifact={artifact} currentArtifact={currentArtifact}
      {...(active ? { sectionId: active.contract_id } : {})}
      onOpenDraft={onOpenDraft} />}
  </section>;
}
