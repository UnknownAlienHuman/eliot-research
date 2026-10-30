// Owner inbox for immutable agent proposal revisions.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { Citation } from '../citations';
import type { ProposalSummary, ProposalView } from '../shared/api';
import { Markdown } from './Markdown';
import type { MarkdownReference } from './Markdown';
import './proposals.css';

class ProposalRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'ProposalRequestError'; }
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  if (response.ok) return await response.json() as T;
  let message = 'Request failed with status ' + response.status + '.';
  try {
    const data = await response.json() as { error?: { message?: unknown } | string; message?: unknown };
    message = typeof data.error === 'string' ? data.error
      : typeof data.error?.message === 'string' ? data.error.message
        : typeof data.message === 'string' ? data.message : message;
  } catch { /* retain the HTTP status */ }
  throw new ProposalRequestError(message, response.status);
}

const readerHref = (projectId: string, citation: Citation) => '/p/' + encodeURIComponent(projectId) + '/source/' +
  encodeURIComponent(citation.sourceId) + '?revisionId=' + encodeURIComponent(citation.revisionId) +
  '&start=' + citation.start + '&end=' + citation.end;
const citationLabel = (citation: Citation) => citation.sourceTitle + ' · ' + citation.block + (citation.deleted ? ' (deleted)' : '');
function citationReferences(projectId: string, citations: readonly Citation[]): MarkdownReference[] {
  const refs = new Map<string, MarkdownReference>();
  for (const citation of citations) for (const text of [citation.label, '[R' + citation.revisionId + ':' + citation.block + ']'])
    if (text) refs.set(text, { text, label: citationLabel(citation), href: readerHref(projectId, citation) });
  return [...refs.values()];
}
const kindLabel = (kind: string) => kind.slice(0, 1).toLocaleUpperCase() + kind.slice(1);
const dateLabel = (timestamp: number) => new Date(timestamp).toLocaleString();
const dateTimeValue = (timestamp: number) => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

export function ProposalsInbox({ projectId, onAccepted }: { readonly projectId: string; readonly onAccepted?: (pageId: string) => void }) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const dialogTitleRef = useRef<HTMLHeadingElement | null>(null);
  const [proposals, setProposals] = useState<ProposalSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [proposal, setProposal] = useState<ProposalView | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState<'accept' | 'reject' | ''>('');
  const [listError, setListError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [decisionError, setDecisionError] = useState('');
  const [notice, setNotice] = useState('');
  const listSeq = useRef(0), detailSeq = useRef(0), decisionLock = useRef(false), mounted = useRef(false);

  const loadList = useCallback(async (cursor: string | null = null, append = false): Promise<void> => {
    if (!projectId) return;
    const seq = ++listSeq.current, base = '/api/projects/' + encodeURIComponent(projectId) + '/proposals';
    if (append) setMoreBusy(true); else setListBusy(true);
    setListError('');
    try {
      const data = await apiJson<{ proposals: ProposalSummary[]; nextCursor: string | null }>(base + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
      if (listSeq.current !== seq) return;
      setProposals((current) => append ? [...(current ?? []), ...data.proposals.filter((item) => !current?.some((known) => known.revisionId === item.revisionId))] : data.proposals);
      setNextCursor(data.nextCursor);
    } catch (error) {
      if (listSeq.current === seq) setListError(error instanceof Error ? error.message : 'Could not load proposals.');
    } finally {
      if (listSeq.current === seq) { setListBusy(false); setMoreBusy(false); }
    }
  }, [projectId]);

  const loadProposal = useCallback(async (revisionId: string): Promise<void> => {
    if (!projectId || decisionLock.current) return;
    const seq = ++detailSeq.current;
    setSelectedId(revisionId); setProposal(null); setDetailError(''); setDecisionError(''); setNotice(''); setDetailBusy(true);
    try {
      const data = await apiJson<{ proposal: ProposalView }>('/api/projects/' + encodeURIComponent(projectId) + '/proposals/' + encodeURIComponent(revisionId));
      if (detailSeq.current === seq) setProposal(data.proposal);
    } catch (error) {
      if (detailSeq.current === seq) setDetailError(error instanceof Error ? error.message : 'Could not open this proposal.');
    } finally { if (detailSeq.current === seq) setDetailBusy(false); }
  }, [projectId]);

  useEffect(() => {
    mounted.current = true;
    void loadList();
    return () => {
      mounted.current = false;
      listSeq.current++; detailSeq.current++;
      dialogRef.current?.close();
    };
  }, [loadList]);

  async function decide(decision: 'accept' | 'reject'): Promise<void> {
    if (decisionLock.current || !proposal || proposal.status !== 'proposed' || (decision === 'accept' && proposal.baseRevisionId !== proposal.headRevisionId)) return;
    const reviewed = proposal;
    decisionLock.current = true; setDecisionBusy(decision); setDecisionError(''); setNotice('');
    try {
      await apiJson('/api/projects/' + encodeURIComponent(projectId) + '/proposals/' + encodeURIComponent(reviewed.revisionId) + '/decision', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, expectedHeadRevisionId: reviewed.headRevisionId }),
      });
      if (!mounted.current) return;
      await loadList();
      if (!mounted.current) return;
      if (decision === 'accept') onAccepted?.(reviewed.pageId);
      setNotice(decision === 'accept' ? 'Proposal accepted.' : 'Proposal rejected; the accepted page is unchanged.');
      setSelectedId(''); setProposal(null);
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ProposalRequestError && error.status === 409) {
        decisionLock.current = false;
        await Promise.all([loadList(), loadProposal(reviewed.revisionId)]);
        if (!mounted.current) return;
        setDecisionError('The page head changed. Review the latest proposal before deciding again.');
      } else setDecisionError(error instanceof Error ? error.message : 'Could not save this decision.');
    } finally { decisionLock.current = false; if (mounted.current) setDecisionBusy(''); }
  }

  const visibleList = proposals;
  const visible = proposal?.revisionId === selectedId ? proposal : null;
  const baseIsCurrent = visible !== null && visible.baseRevisionId === visible.headRevisionId;
  const references = visible ? citationReferences(projectId, visible.citations) : [];
  const listPending = listBusy || moreBusy;
  return (
    <section className="er-proposals" aria-label="Agent proposals" aria-busy={listPending}>
      <button
        className="er-button er-button--tonal er-proposals__trigger"
        type="button"
        aria-haspopup="dialog"
        aria-controls={id + '-dialog'}
        onClick={() => {
          const dialog = dialogRef.current;
          if (dialog && !dialog.open) {
            dialog.showModal();
            dialogTitleRef.current?.focus();
          }
        }}
      >
        Agent proposals{visibleList === null ? '' : ' (' + visibleList.length + (nextCursor ? '+' : '') + ')'}
      </button>
      <dialog
        ref={dialogRef}
        id={id + '-dialog'}
        className="er-dialog er-proposals__dialog"
        aria-labelledby={id + '-title'}
        aria-busy={listPending || detailBusy || decisionBusy !== ''}
      >
        <header className="er-proposals__header">
          <div>
            <h2 className="er-dialog__title" id={id + '-title'} ref={dialogTitleRef} tabIndex={-1}>Agent proposals</h2>
            <p>Review a cited draft before it becomes project knowledge.</p>
          </div>
          <div className="er-proposals__header-actions">
            <button className="er-button er-button--text" type="button" disabled={listPending} onClick={() => void loadList()}>
              {listBusy ? 'Refreshing…' : 'Refresh'}
            </button>
            <button className="er-button er-button--text" type="button" onClick={() => dialogRef.current?.close()}>Close</button>
          </div>
        </header>
        <div className="er-dialog__body">
          <div className="er-proposals__layout">
            <section className="er-proposals__list er-card" aria-label="Pending proposals" aria-busy={listPending}>
              {visibleList === null && listBusy ? <p role="status">Loading proposals…</p> : null}
              {listError ? <div role="alert"><p>Could not load proposals.</p><button className="er-button er-button--text" type="button" onClick={() => void loadList()}>Retry</button></div> : null}
              {visibleList?.length === 0 ? <p>No proposals are waiting for review.</p> : null}
              {visibleList?.length ? (
                <ul>
                  {visibleList.map((item) => (
                    <li key={item.revisionId}>
                      <button
                        className="er-button er-button--text er-proposals__open"
                        type="button"
                        disabled={decisionBusy !== ''}
                        aria-pressed={selectedId === item.revisionId}
                        onClick={() => void loadProposal(item.revisionId)}
                      >
                        <span>{item.title}</span>
                        <small>{kindLabel(item.kind)} · Submitted <time dateTime={dateTimeValue(item.createdAt)}>{dateLabel(item.createdAt)}</time></small>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {nextCursor ? (
                <button className="er-button er-button--text" type="button" disabled={listPending} onClick={() => void loadList(nextCursor, true)}>
                  {moreBusy ? 'Loading…' : 'Load more'}
                </button>
              ) : null}
            </section>
            <section className="er-proposals__review er-card" aria-label="Proposal review" aria-busy={detailBusy || decisionBusy !== ''}>
              {notice ? <p role="status">{notice}</p> : null}
              {decisionError ? <p role="alert">{decisionError}</p> : null}
              {!selectedId ? <p>Choose a proposal to review its body and citations.</p> : null}
              {selectedId && detailBusy ? <p role="status">Loading proposal…</p> : null}
              {detailError ? <div role="alert"><p>Could not open this proposal.</p><button className="er-button er-button--text" type="button" onClick={() => void loadProposal(selectedId)}>Retry</button></div> : null}
              {visible ? <article>
                <p>{kindLabel(visible.kind)} · {visible.status} · Submitted <time dateTime={dateTimeValue(visible.createdAt)}>{dateLabel(visible.createdAt)}</time></p>
                <h3>{visible.title}</h3>
                {visible.status === 'proposed' ? <p role="status">{baseIsCurrent ? visible.baseRevisionId ? 'Based on the current accepted page.' : 'New page proposal.' : 'Accepted page changed; request a new proposal before accepting.'}</p> : null}
                <details>
                  <summary>Source citations</summary>
                  <p>From: {visible.actor}</p>
                  <ul>
                    {visible.citations.map((citation: Citation) => (
                      <li key={citation.revisionId + ':' + citation.block + ':' + citation.start}>
                        <Link className="er-citation" to={readerHref(projectId, citation)}>{citationLabel(citation)}</Link>
                      </li>
                    ))}
                  </ul>
                </details>
                <div className="er-proposals__markdown"><Markdown text={visible.body} references={references} /></div>
                {visible.status === 'proposed' ? (
                  <div className="er-proposals__actions">
                    <button className="er-button er-button--text" type="button" disabled={decisionBusy !== ''} onClick={() => void decide('reject')}>
                      {decisionBusy === 'reject' ? 'Rejecting…' : 'Reject'}
                    </button>
                    <button className="er-button er-button--tonal" type="button" disabled={decisionBusy !== '' || !baseIsCurrent} onClick={() => void decide('accept')}>
                      {decisionBusy === 'accept' ? 'Accepting…' : 'Accept'}
                    </button>
                  </div>
                ) : <p>This proposal is already {visible.status}.</p>}
              </article> : null}
            </section>
          </div>
        </div>
      </dialog>
    </section>
  );
}
