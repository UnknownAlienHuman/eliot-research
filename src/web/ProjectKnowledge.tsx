import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { Citation } from '../citations';
import type { KnowledgeData, KnowledgeView } from '../knowledge';
import { Markdown } from './Markdown';
import type { MarkdownReference } from './Markdown';
import './project-knowledge.css';
import './understanding.css';

const POLL_MS = 3000;

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch { /* Fall through to the status code. */ }
  return 'Request failed with status ' + response.status + '.';
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  if (!response.ok) throw new Error(await responseError(response));
  return (await response.json()) as T;
}

async function apiRequest(path: string, init: RequestInit): Promise<void> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  if (!response.ok) throw new Error(await responseError(response));
}

function sourceHref(projectId: string, sourceId: string, revisionId?: string, start?: number, end?: number): string {
  const query = new URLSearchParams();
  if (revisionId) query.set('revisionId', revisionId);
  if (start !== undefined) query.set('start', String(start));
  if (end !== undefined) query.set('end', String(end));
  const suffix = query.size === 0 ? '' : '?' + query.toString();
  return '/p/' + encodeURIComponent(projectId) + '/source/' + encodeURIComponent(sourceId) + suffix;
}

function pageReferences(projectId: string, citations: readonly Citation[]): MarkdownReference[] {
  const references: MarkdownReference[] = [];
  for (const citation of citations) {
    const href = sourceHref(projectId, citation.sourceId, citation.revisionId, citation.start, citation.end);
    for (const label of [citation.label, '[R' + citation.revisionId + ':' + citation.block + ']']) {
      if (label !== '' && !references.some((reference) => reference.text === label)) {
        references.push({ text: label, href });
      }
    }
  }
  return references;
}

function knownNumber(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : 'unknown';
}

function knownCost(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? '$' + (value / 1_000_000).toFixed(6)
    : 'unknown';
}

function stateLabel(state: KnowledgeView['state']): string {
  switch (state) {
    case 'none': return 'Not built';
    case 'running': return 'Running';
    case 'paused': return 'Paused';
    case 'done': return 'Ready';
    case 'failed': return 'Failed';
  }
}

function SourceLinks({ projectId, sourceIds, sources }: {
  readonly projectId: string;
  readonly sourceIds: readonly string[];
  readonly sources: ReadonlyMap<string, KnowledgeData['sources'][number]>;
}) {
  if (sourceIds.length === 0) return <p className="er-pk__hint">No source links recorded.</p>;
  return (
    <ul className="er-pk__source-links">
      {sourceIds.map((sourceId, index) => {
        const source = sources.get(sourceId);
        return (
          <li key={sourceId + ':' + index}>
            <Link to={sourceHref(projectId, sourceId, source?.revisionId)}>
              {source?.title ?? 'Source ' + sourceId}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function ProjectKnowledge({ projectId }: { readonly projectId: string }) {
  const [view, setView] = useState<KnowledgeView | null>(null);
  const [viewProjectId, setViewProjectId] = useState(projectId);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState('');
  const [readErrorProjectId, setReadErrorProjectId] = useState(projectId);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [readVersion, setReadVersion] = useState(0);
  const requestSequence = useRef(0);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    if (projectId === '') {
      setView(null);
      setViewProjectId('');
      setReadError('Open project knowledge from a project.');
      setReadErrorProjectId('');
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let timer: number | undefined;
    let live = true;
    setLoading(true);
    setReadError('');
    setReadErrorProjectId(projectId);

    const read = async (): Promise<void> => {
      try {
        const next = await apiJson<KnowledgeView>(
          '/api/projects/' + encodeURIComponent(projectId) + '/knowledge',
          { signal: controller.signal },
        );
        if (!live || sequence !== requestSequence.current) return;
        setView(next);
        setViewProjectId(projectId);
        setReadError('');
        setLoading(false);
        if (next.state === 'running') timer = window.setTimeout(() => { void read(); }, POLL_MS);
      } catch (error) {
        if (!live || controller.signal.aborted || sequence !== requestSequence.current) return;
        setReadError(error instanceof Error ? error.message : 'Could not load project knowledge.');
        setReadErrorProjectId(projectId);
        setLoading(false);
      }
    };

    void read();
    return () => {
      live = false;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
      if (requestSequence.current === sequence) requestSequence.current += 1;
    };
  }, [projectId, readVersion]);

  const knowledgePath = '/api/projects/' + encodeURIComponent(projectId) + '/knowledge';
  const currentView = viewProjectId === projectId ? view : null;
  const currentReadError = readErrorProjectId === projectId ? readError : '';
  const currentLoading = loading || (currentView === null && currentReadError === '');
  const canRequest = actionBusy === null && currentView !== null && currentView.state !== 'running' && !currentLoading && projectId !== '';

  async function requestRefresh(): Promise<void> {
    if (!canRequest) return;
    setActionBusy('refresh');
    setActionError('');
    setNotice('');
    try {
      await apiRequest(knowledgePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mutationId: crypto.randomUUID() }),
      });
      setNotice('Update requested.');
      setLoading(true);
      setReadVersion((version) => version + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not request a project map refresh.');
    } finally {
      setActionBusy(null);
    }
  }

  async function createWiki(topicId: string, title: string): Promise<void> {
    const busyKey = 'wiki:' + topicId;
    if (!canRequest) return;
    setActionBusy(busyKey);
    setActionError('');
    setNotice('');
    try {
      await apiRequest(knowledgePath + '/wiki', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topicId, mutationId: crypto.randomUUID() }),
      });
      setNotice('Wiki request accepted for “' + title + '”. The saved page will appear when it is available.');
      setLoading(true);
      setReadVersion((version) => version + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not request this Wiki page.');
    } finally {
      setActionBusy(null);
    }
  }
  async function recheckSavedWiki(): Promise<void> {
    const revisionId = currentView?.operation?.kind === 'wiki' ? currentView.operation.revisionId : null;
    if (!canRequest || currentView?.canRecheckWiki !== true || revisionId === null) return;
    setActionBusy('wiki-recheck');
    setActionError('');
    setNotice('');
    try {
      await apiRequest(knowledgePath + '/wiki/recheck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revisionId, mutationId: crypto.randomUUID() }),
      });
      setNotice('Saved Wiki rechecked; open it in Studio.');
      setLoading(true);
      setReadVersion((version) => version + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not recheck the saved Wiki.');
    } finally {
      setActionBusy(null);
    }
  }

  if (projectId === '') {
    return <p className="er-pk__error" role="alert">Open project knowledge from a project.</p>;
  }

  const data = currentView?.data ?? null;
  const sources = new Map((data?.sources ?? []).map((source) => [source.sourceId, source]));
  const studioHref = '/p/' + encodeURIComponent(projectId) + '/studio';

  return (
    <section className="er-project-knowledge" aria-labelledby="er-pk-title" aria-busy={currentLoading}>
      <header className="er-pk__header">
        <div className="er-pk__heading">
          <h1 className="er-pk__title" id="er-pk-title">Project knowledge</h1>
          <p className="er-pk__hint">A source-linked map of topics, comparable results, open questions, and reading routes.</p>
        </div>
        <div className="er-pk__actions">
          {currentView?.page ? <Link className="er-button er-button--text" to={studioHref}>Open in Studio</Link> : null}
          <button className="er-button er-button--tonal" type="button" disabled={!canRequest} onClick={() => { void requestRefresh(); }}>
            {actionBusy === 'refresh' ? 'Requesting…' : currentView?.state === 'none' ? 'Build project map' : 'Refresh project map'}
          </button>
        </div>
      </header>

      {currentLoading && currentView === null ? <p className="er-pk__hint" role="status">Loading project knowledge…</p> : null}
      {currentReadError !== '' ? (
        <div className="er-pk__alert" role="alert">
          <p>{currentReadError}</p>
          <button className="er-button er-button--text" type="button" onClick={() => { setReadVersion((version) => version + 1); }}>Reload status</button>
        </div>
      ) : null}
      {actionError !== '' ? <p className="er-pk__error" role="alert">{actionError} You can try the explicit action again.</p> : null}
      {notice !== '' ? <p className="er-pk__notice" role="status">{notice}</p> : null}

      {currentView ? (
        <>
          {currentView.state !== 'none' ? (
            <div className="er-pk__status" data-state={currentView.state} role="status">
              <strong>{currentView.state === 'done' && currentView.operation?.kind === 'wiki' && currentView.error ? 'Review needed' : stateLabel(currentView.state)}</strong>
              <span>
                {currentView.state === 'running' ? currentView.operation?.kind === 'wiki' ? 'Writing the Wiki page…' : 'Updating the project map…' : null}
                {currentView.state === 'paused' ? 'Update paused. Check the reason above before trying again.' : null}
                {currentView.state === 'done' && currentView.operation?.kind !== 'wiki' ? 'Project knowledge is ready.' : null}
                {currentView.state === 'done' && currentView.operation?.kind === 'wiki' && !currentView.error ? 'Saved Wiki is ready; the displayed map is not the Wiki.' : null}
                {currentView.state === 'done' && currentView.operation?.kind === 'wiki' && currentView.error ? 'Saved Wiki output needs review; the displayed map is not the Wiki.' : null}
                {currentView.state === 'failed' ? 'Update failed. Any previous page remains available for review.' : null}
              </span>
              {currentView.error ? <span className="er-pk__status-error">{currentView.error}</span> : null}
              {currentView.canRecheckWiki === true && currentView.operation?.kind === 'wiki' ? (
                <span>
                  <button className="er-button er-button--text" type="button" disabled={!canRequest || currentView.canRecheckWiki !== true} onClick={() => { void recheckSavedWiki(); }}>
                    {actionBusy === 'wiki-recheck' ? 'Rechecking…' : 'Recheck saved Wiki'}
                  </button>
                </span>
              ) : null}
            </div>
          ) : null}

          {currentView.state !== 'none' && currentView.usage !== null ? (
            <div className="er-pk__usage" aria-label="Project knowledge usage">
              <strong>Usage</strong>
              <span>{knownNumber(currentView.usage.calls)} calls</span>
              <span>{knownNumber(currentView.usage.inputTokens)} input tokens</span>
              <span>{knownNumber(currentView.usage.outputTokens)} output tokens</span>
              <span>{knownCost(currentView.usage.estimatedCostMicrousd)} estimated cost</span>
            </div>
          ) : null}

          {currentView.state === 'none' && currentView.page === null && currentView.data === null ? (
            <div className="er-pk__empty">
              <h2>No project map yet</h2>
              <p>Read and distill project sources, then build the map with the explicit action above.</p>
            </div>
          ) : null}

          {currentView.state !== 'none' && currentView.data === null ? (
            <p className="er-pk__hint">Structured map details are not available in this response. You can request a refresh above.</p>
          ) : null}

          {data ? (
            <div className="er-pk__grid">
              <section className="er-pk__panel" aria-labelledby="er-pk-topics-title">
                <header className="er-pk__panel-head">
                  <h2 id="er-pk-topics-title">Topics</h2>
                  <span className="er-pk__count">{data.topics.length}</span>
                </header>
                {data.topics.length === 0 ? (
                  <p className="er-pk__hint">No topics are available. Add and read sources, then refresh the map.</p>
                ) : (
                  <ul className="er-pk__list">
                    {data.topics.map((topic) => (
                      <li className="er-pk__topic" key={topic.id}>
                        <div className="er-pk__topic-head">
                          <h3>{topic.title}</h3>
                          <button className="er-button er-button--text" type="button" disabled={!canRequest || currentView.page?.freshness === 'stale'} onClick={() => { void createWiki(topic.id, topic.title); }}>
                            {actionBusy === 'wiki:' + topic.id ? 'Requesting…' : 'Create Wiki'}
                          </button>
                        </div>
                        <SourceLinks projectId={projectId} sourceIds={topic.sourceIds} sources={sources} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="er-pk__panel er-pk__panel--wide" aria-labelledby="er-pk-comparisons-title">
                <header className="er-pk__panel-head">
                  <h2 id="er-pk-comparisons-title">Comparisons</h2>
                  <span className="er-pk__count">{data.comparisons.length}</span>
                </header>
                {data.comparisons.length === 0 ? (
                  <p className="er-pk__hint">No compatible multi-source results are available yet.</p>
                ) : (
                  <ol className="er-pk__list er-pk__comparisons">
                    {data.comparisons.map((group, index) => (
                      <li className="er-pk__comparison" key={group.id}>
                        <header className="er-pk__comparison-head">
                          <h3>Comparison {index + 1}</h3>
                          {group.disagreement ? <span className="er-pk__badge">Disagreement CANDIDATE</span> : null}
                        </header>
                        <ul className="er-pk__comparison-rows">
                          {group.rows.map((row) => {
                            const source = sources.get(row.sourceId);
                            return (
                              <li className="er-pk__comparison-row" key={row.id}>
                                <Link to={sourceHref(projectId, row.sourceId, row.revisionId, row.start, row.end)} title={row.revisionId + ' [' + row.start + ', ' + row.end + ')'}>
                                  {source?.title ?? 'Source ' + row.sourceId}
                                </Link>
                                <dl className="er-pk__facts">
                                  <div><dt>Task</dt><dd>{row.task ?? 'Unknown'}</dd></div>
                                  <div><dt>Metric</dt><dd>{row.metric ?? 'Unknown'}</dd></div>
                                  <div><dt>Dataset</dt><dd>{row.dataset ?? 'Unknown'}</dd></div>
                                  <div><dt>Reported value</dt><dd>{row.valueText ?? 'Unknown'}</dd></div>
                                  <div><dt>Unit</dt><dd>{row.unit ?? 'Unknown'}</dd></div>
                                  <div><dt>Condition</dt><dd>{row.conditions ?? 'Unknown'}</dd></div>
                                </dl>
                                <blockquote className="er-pk__quote">{row.quote}</blockquote>
                                <Link className="er-pk__reader-link" to={sourceHref(projectId, row.sourceId, row.revisionId, row.start, row.end)}>
                                  Open exact quote · block {row.block} · UTF-8 bytes [{row.start}, {row.end})
                                </Link>
                              </li>
                            );
                          })}
                        </ul>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <section className="er-pk__panel" aria-labelledby="er-pk-gaps-title">
                <header className="er-pk__panel-head">
                  <h2 id="er-pk-gaps-title">Open questions</h2>
                  <span className="er-pk__count">{data.gaps.length}</span>
                </header>
                {data.gaps.length === 0 ? (
                  <p className="er-pk__hint">No open questions were recorded.</p>
                ) : (
                  <ul className="er-pk__list">
                    {data.gaps.map((gap, index) => (
                      <li className="er-pk__item" key={gap.question + ':' + index}>
                        <p>{gap.question}</p>
                        <SourceLinks projectId={projectId} sourceIds={gap.sourceIds} sources={sources} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="er-pk__panel" aria-labelledby="er-pk-routes-title">
                <header className="er-pk__panel-head">
                  <h2 id="er-pk-routes-title">Reading routes</h2>
                  <span className="er-pk__count">{data.routes.length}</span>
                </header>
                {data.routes.length === 0 ? (
                  <p className="er-pk__hint">No reading routes were recorded.</p>
                ) : (
                  <ul className="er-pk__list">
                    {data.routes.map((route, index) => (
                      <li className="er-pk__item" key={route.title + ':' + index}>
                        <p>{route.title}</p>
                        <SourceLinks projectId={projectId} sourceIds={route.sourceIds} sources={sources} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          ) : null}

          {currentView.page ? (
            <article className="er-pk__saved-page" aria-labelledby="er-pk-page-title">
              <header className="er-pk__panel-head">
                <div>
                  <p className="er-pk__eyebrow">Saved {currentView.page.kind}</p>
                  <h2 id="er-pk-page-title">{currentView.page.title}</h2>
                </div>
                <div className="er-pk__page-meta">
                  <span className="er-pk__badge" data-freshness={currentView.page.freshness}>{currentView.page.freshness === 'stale' ? 'Stale' : 'Current'}</span>
                </div>
              </header>
              {currentView.page.freshness === 'stale' ? (
                <p className="er-pk__stale" role="status">This accepted page is stale because its source inputs changed. It remains available while you review or refresh it.</p>
              ) : null}
              <div className="er-und__answer">
                <Markdown text={currentView.page.body} references={pageReferences(projectId, currentView.page.citations)} />
              </div>
            </article>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
