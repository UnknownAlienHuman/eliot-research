import { useEffect, useId, useRef, useState } from 'react';
import type { CatalogModel } from '../models';
import { OCR_LIMITS } from '../shared/api';
import type { OcrJobView } from '../shared/api';
import { ModelPicker, modelCatalogEntryKey } from './ModelPicker';
import { loadPdfPages } from './pdf-pages';
import './ocr.css';

interface SourceOcrProps {
  readonly projectId: string;
  readonly sourceId: string;
  readonly revisionId: string;
  readonly onApplied: (revisionId: string) => void;
}
type PdfPages = Awaited<ReturnType<typeof loadPdfPages>>;
class OcrRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init,
    headers: { Accept: 'application/json', ...init.headers } });
  if (!response.ok) {
    let message = 'OCR request failed (' + response.status + ').';
    try { const body = await response.json() as { error?: { message?: string } }; message = body.error?.message || message; }
    catch { /* Keep the HTTP error when a response is not JSON. */ }
    throw new OcrRequestError(message, response.status);
  }
  return response;
}
async function json<T>(url: string, init: RequestInit = {}): Promise<T> {
  return (await request(url, init)).json() as Promise<T>;
}
const post = (body: object, signal: AbortSignal): RequestInit => ({ method: 'POST', signal,
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const active = (job: OcrJobView) => ['preparing', 'queued', 'running'].includes(job.state);
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Could not complete this OCR action.';
function outputBound(model: CatalogModel | undefined): number | null {
  const value = model?.outputReserveTokens ?? model?.maxOutputTokens;
  if (value == null || !Number.isSafeInteger(value) || value <= 0) return null;
  const bound = Math.min(value, model?.maxOutputTokens ?? value);
  return Number.isSafeInteger(bound) && bound > 0 ? bound : null;
}

export function SourceOcr(props: SourceOcrProps) {
  return <OcrDialog key={props.projectId + ':' + props.sourceId + ':' + props.revisionId} {...props} />;
}

function OcrDialog({ projectId, sourceId, revisionId, onApplied }: SourceOcrProps) {
  const id = useId();
  const base = '/api/projects/' + encodeURIComponent(projectId) + '/sources/' + encodeURIComponent(sourceId) + '/ocr';
  const originalUrl = '/api/revisions/' + encodeURIComponent(revisionId) + '/original';
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const generation = useRef(0), jobVersion = useRef(0), selectedId = useRef(''), mutationLock = useRef(false);
  const reads = useRef<AbortController | null>(null), work = useRef<AbortController | null>(null);
  const pdfAbort = useRef<AbortController | null>(null), pdf = useRef<PdfPages | null>(null);
  const originalBytes = useRef<ArrayBuffer | null>(null);
  const [opened, setOpened] = useState(false);
  const [models, setModels] = useState<CatalogModel[]>([]), [modelRoute, setModelRoute] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(false), [catalogError, setCatalogError] = useState('');
  const [catalogWarnings, setCatalogWarnings] = useState<string[]>([]), [routePending, setRoutePending] = useState(false);
  const [pdfInfo, setPdfInfo] = useState<{ pageCount: number; sha256: string } | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false), [pdfError, setPdfError] = useState('');
  const [jobs, setJobs] = useState<OcrJobView[]>([]), [jobsLoaded, setJobsLoaded] = useState(false);
  const [job, setJob] = useState<OcrJobView | null>(null), [unconfirmed, setUnconfirmed] = useState(false);
  const [error, setError] = useState(''), [stage, setStage] = useState('');
  const [action, setAction] = useState<'' | 'cancel' | 'apply'>('');
  const [preview, setPreview] = useState(''), [previewLoading, setPreviewLoading] = useState(false);
  const [previewFor, setPreviewFor] = useState(''), [previewError, setPreviewError] = useState('');
  const [previewVersion, setPreviewVersion] = useState(0);
  const live = (epoch: number) => generation.current === epoch && dialog.current?.open === true;

  function remember(next: OcrJobView): void {
    if (next.sourceId !== sourceId || next.projectId !== projectId) throw new Error('This OCR run belongs to another source.');
    setJobs(current => [next, ...current.filter(item => item.id !== next.id)].slice(0, 10));
    if (selectedId.current === next.id) { setJob(next); setUnconfirmed(false); }
  }
  function release(): void {
    generation.current++;
    reads.current?.abort(); reads.current = null;
    work.current?.abort(); work.current = null;
    pdfAbort.current?.abort(); pdfAbort.current = null;
    const loaded = pdf.current; pdf.current = null;
    void loaded?.destroy().catch(() => undefined);
    originalBytes.current = null;
    mutationLock.current = false;
  }
  async function renderer(epoch: number): Promise<PdfPages> {
    if (pdf.current) return pdf.current;
    const bytes = originalBytes.current;
    if (!bytes) throw new Error('Reopen OCR to load the original PDF.');
    const controller = new AbortController(); pdfAbort.current = controller;
    const loaded = await loadPdfPages(bytes.slice(0), controller.signal);
    if (!live(epoch)) { await loaded.destroy(); throw new DOMException('OCR dialog closed.', 'AbortError'); }
    pdf.current = loaded;
    return loaded;
  }
  async function readJob(jobId: string, epoch: number, signal: AbortSignal): Promise<void> {
    const version = jobVersion.current;
    try {
      const data = await json<{ job: OcrJobView }>(base + '/' + encodeURIComponent(jobId), { signal });
      if (live(epoch) && version === jobVersion.current && selectedId.current === jobId) { remember(data.job); setError(''); }
    } catch (failure) {
      if (!live(epoch) || signal.aborted || version !== jobVersion.current || selectedId.current !== jobId) return;
      if (failure instanceof OcrRequestError && failure.status === 404) {
        selectedId.current = ''; setJob(null); setUnconfirmed(false);
      }
      setError(messageOf(failure));
    }
  }
  async function readJobs(epoch: number, signal: AbortSignal): Promise<void> {
    const version = jobVersion.current;
    const data = await json<{ jobs: OcrJobView[] }>(base, { signal });
    if (!live(epoch) || version !== jobVersion.current) return;
    if (data.jobs.some(item => item.sourceId !== sourceId || item.projectId !== projectId)) throw new Error('Could not identify this source’s OCR runs.');
    const recent = data.jobs.slice(0, 10);
    setJobs(recent); setJobsLoaded(true);
    const next = recent.find(item => item.id === selectedId.current) ?? recent.find(active) ?? recent[0];
    if (selectedId.current && !recent.some(item => item.id === selectedId.current)) {
      await readJob(selectedId.current, epoch, signal);
    } else if (next) { selectedId.current = next.id; remember(next); }
    else { setJob(null); setUnconfirmed(false); }
  }

  useEffect(() => {
    if (!opened) return;
    const epoch = ++generation.current, controller = new AbortController(); reads.current = controller;
    setCatalogLoading(true); setCatalogError(''); setCatalogWarnings([]);
    setPdfLoading(true); setPdfInfo(null); setPdfError(''); setJobsLoaded(false); setError('');
    setStage(''); setAction('');
    void json<{ models: CatalogModel[]; defaultModel?: string | null; warnings?: string[] }>('/api/models', { signal: controller.signal })
      .then(data => { if (live(epoch)) { setModels(data.models); setModelRoute(data.defaultModel ?? ''); setCatalogWarnings(data.warnings ?? []); } })
      .catch(failure => { if (live(epoch) && !controller.signal.aborted) setCatalogError(messageOf(failure)); })
      .finally(() => { if (live(epoch)) setCatalogLoading(false); });
    void (async () => {
      const response = await request(originalUrl, { signal: controller.signal, headers: { Accept: 'application/pdf' } });
      const bytes = await response.arrayBuffer();
      if (!live(epoch)) return;
      originalBytes.current = bytes;
      const loaded = await renderer(epoch);
      if (live(epoch)) setPdfInfo({ pageCount: loaded.pageCount, sha256: loaded.sha256 });
    })().catch(failure => { if (live(epoch) && !controller.signal.aborted) setPdfError(messageOf(failure)); })
      .finally(() => { if (live(epoch)) setPdfLoading(false); });
    void readJobs(epoch, controller.signal).catch(failure => { if (live(epoch) && !controller.signal.aborted) setError(messageOf(failure)); });
    return release;
  }, [opened, base, originalUrl]);

  useEffect(() => {
    if (!opened || !job || !['queued', 'running'].includes(job.state)) return;
    const epoch = generation.current, jobId = job.id, controller = new AbortController();
    let timer = 0;
    async function poll(): Promise<void> {
      if (mutationLock.current) return;
      const version = jobVersion.current;
      try {
        const data = await json<{ job: OcrJobView }>(base + '/' + encodeURIComponent(jobId), { signal: controller.signal });
        if (!live(epoch) || controller.signal.aborted || version !== jobVersion.current || selectedId.current !== jobId) return;
        remember(data.job);
        if (['queued', 'running'].includes(data.job.state)) timer = window.setTimeout(() => void poll(), 1500);
      } catch (failure) {
        if (live(epoch) && !controller.signal.aborted && version === jobVersion.current && selectedId.current === jobId) setError(messageOf(failure) + ' Check the run status before taking another action.');
      }
    }
    timer = window.setTimeout(() => void poll(), 1500);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [opened, base, job?.id, job?.state]);

  useEffect(() => {
    setPreview(''); setPreviewFor(''); setPreviewError('');
    if (!opened || !job || job.state !== 'ready') { setPreviewLoading(false); return; }
    const epoch = generation.current, jobId = job.id, controller = new AbortController();
    setPreviewLoading(true);
    void json<{ text: string }>(base + '/' + encodeURIComponent(jobId) + '/preview', { signal: controller.signal })
      .then(data => { if (live(epoch) && selectedId.current === jobId) { setPreview(data.text); setPreviewFor(jobId); } })
      .catch(failure => { if (live(epoch) && !controller.signal.aborted && selectedId.current === jobId) setPreviewError(messageOf(failure)); })
      .finally(() => { if (live(epoch) && selectedId.current === jobId) setPreviewLoading(false); });
    return () => controller.abort();
  }, [opened, base, job?.id, job?.state, previewVersion]);

  const choices = models.map(model => model.supportsImages === false
    ? { ...model, enabled: false, unavailableReason: 'This model does not accept images for OCR.' } : model);
  const matching = choices.filter(model => model.route === modelRoute);
  const chosen = matching.length === 1 ? matching[0] : undefined;
  const uniqueChoice = chosen !== undefined && choices.filter(model => modelCatalogEntryKey(model) === modelCatalogEntryKey(chosen)).length === 1;
  const output = outputBound(chosen);
  const busy = stage !== '' || action !== '';
  const hasActiveRun = jobs.some(active) || (job !== null && active(job));
  const canRun = jobsLoaded && pdfInfo !== null && !pdfLoading && catalogError === '' && !catalogLoading
    && chosen?.enabled === true && uniqueChoice && !routePending && !busy && !hasActiveRun && !unconfirmed;
  const previewLoaded = job !== null && previewFor === job.id;
  const previewBytes = previewLoaded ? new TextEncoder().encode(preview).byteLength : 0;

  async function run(): Promise<void> {
    if (!canRun || work.current || mutationLock.current || !pdfInfo || !chosen || !originalBytes.current
      || !reads.current || reads.current.signal.aborted || !dialog.current?.open) return;
    const epoch = generation.current, controller = new AbortController(), jobId = crypto.randomUUID();
    const frozenPdf = pdfInfo, route = chosen.route;
    jobVersion.current++;
    work.current = controller; selectedId.current = jobId;
    setJob(null); setUnconfirmed(false); setError(''); setStage('Creating OCR run…');
    try {
      const created = await json<{ job: OcrJobView }>(base, post({ jobId, baseRevisionId: revisionId,
        model: route, pageCount: frozenPdf.pageCount, originalSha256: frozenPdf.sha256 }, controller.signal));
      controller.signal.throwIfAborted();
      if (!live(epoch)) return;
      if (created.job.id !== jobId) throw new Error('The OCR response did not identify the requested run.');
      remember(created.job);
      const loaded = await renderer(epoch);
      for (let page = 1; page <= frozenPdf.pageCount; page++) {
        controller.signal.throwIfAborted();
        setStage('Preparing page ' + page + ' of ' + frozenPdf.pageCount + '…');
        const png = await loaded.renderPage(page);
        controller.signal.throwIfAborted();
        if (png.type !== 'image/png' || png.size === 0 || png.size > OCR_LIMITS.pageBytes) throw new Error('A complete page could not fit the PNG upload limit. This run has not started.');
        await request(base + '/' + jobId + '/pages/' + page, { method: 'PUT', signal: controller.signal,
          headers: { 'Content-Type': 'image/png' }, body: png });
      }
      controller.signal.throwIfAborted();
      setStage('Starting OCR…');
      const started = await json<{ job: OcrJobView }>(base + '/' + jobId + '/start', post({}, controller.signal));
      if (live(epoch) && !controller.signal.aborted) remember(started.job);
    } catch (failure) {
      if (live(epoch) && !controller.signal.aborted) { setUnconfirmed(true); setError(messageOf(failure) + ' This run will not restart automatically. Check its status.'); }
    } finally {
      if (work.current === controller) { work.current = null; if (live(epoch)) setStage(''); }
    }
  }
  async function stop(): Promise<void> {
    const jobId = selectedId.current, signal = reads.current?.signal;
    if (!jobId || !signal || mutationLock.current) return;
    const epoch = generation.current;
    jobVersion.current++;
    mutationLock.current = true; setAction('cancel'); setError('');
    work.current?.abort(); work.current = null; setStage('');
    pdfAbort.current?.abort(); pdf.current = null;
    try {
      const data = await json<{ job: OcrJobView }>(base + '/' + encodeURIComponent(jobId) + '/cancel', post({}, signal));
      if (live(epoch)) remember(data.job);
    } catch (failure) {
      if (live(epoch) && !signal.aborted) { setUnconfirmed(true); setError(messageOf(failure) + ' Cancellation is unconfirmed; check the run status.'); }
    } finally { if (live(epoch)) { mutationLock.current = false; setAction(''); } }
  }
  async function apply(): Promise<void> {
    const signal = reads.current?.signal;
    if (!job || job.state !== 'ready' || job.baseRevisionId !== revisionId || !previewLoaded || !preview.trim()
      || previewBytes > OCR_LIMITS.previewBytes || busy || unconfirmed || !signal || mutationLock.current) return;
    const epoch = generation.current, jobId = job.id;
    jobVersion.current++;
    mutationLock.current = true; setAction('apply'); setError('');
    try {
      const data = await json<{ revisionId: string }>(base + '/' + encodeURIComponent(jobId) + '/apply', post({ text: preview }, signal));
      if (live(epoch)) { dialog.current?.close(); onApplied(data.revisionId); }
    } catch (failure) {
      if (live(epoch) && !signal.aborted) { setUnconfirmed(true); setError(messageOf(failure) + ' Applying is unconfirmed; check the run status before trying again.'); }
    } finally { if (live(epoch)) { mutationLock.current = false; setAction(''); } }
  }
  function checkStatus(): void {
    const signal = reads.current?.signal;
    if (!signal || work.current || mutationLock.current) return;
    const epoch = generation.current;
    setError('');
    if (selectedId.current && jobsLoaded) void readJob(selectedId.current, epoch, signal);
    else void readJobs(epoch, signal).catch(failure => { if (live(epoch) && !signal.aborted) setError(messageOf(failure)); });
  }

  return <>
    <button type='button' className='er-button er-button--tonal' aria-haspopup='dialog' aria-controls={id + '-dialog'}
      onClick={() => { if (dialog.current && !dialog.current.open) { dialog.current.showModal(); setOpened(true); heading.current?.focus(); } }}>OCR original PDF</button>
    <dialog ref={dialog} id={id + '-dialog'} className='er-dialog er-ocr' aria-labelledby={id + '-title'}
      onClose={() => { release(); setOpened(false); }}>
      <header className='er-ocr__header'>
        <h2 ref={heading} tabIndex={-1} id={id + '-title'} className='er-dialog__title'>Read scanned PDF with OCR</h2>
        <button type='button' className='er-button er-button--text' onClick={() => dialog.current?.close()}>Close</button>
      </header>
      <div className='er-dialog__body er-ocr__body'>
        <p>The original PDF is retained. Run processes every page using the chosen image model. Review the text before explicitly applying it as a new readable revision.</p>
        <a href={job ? '/api/revisions/' + encodeURIComponent(job.baseRevisionId) + '/original' : originalUrl} target='_blank' rel='noreferrer'>Open original PDF</a>
        {pdfLoading ? <p role='status'>Loading original PDF…</p> : null}
        {pdfError ? <p className='er-status er-status--error' role='alert'>{pdfError} Close and reopen OCR to reload the PDF.</p> : null}
        <fieldset className='er-ocr__model' disabled={busy || hasActiveRun || unconfirmed}>
          <ModelPicker label='OCR model' choices={choices} value={modelRoute} onChange={setModelRoute} compact
            loading={catalogLoading} error={catalogError} warnings={catalogWarnings} onRoutePendingChange={setRoutePending} />
        </fieldset>
        {chosen && chosen.supportsImages === undefined ? <p role='note'>Image support is not published for this model. The API may reject the run; OCR will not switch models or retry automatically.</p> : null}
        {pdfInfo ? <p className='er-ocr__bound'>Complete PDF: {pdfInfo.pageCount.toLocaleString()} page{pdfInfo.pageCount === 1 ? '' : 's'} · at most {pdfInfo.pageCount.toLocaleString()} model call{pdfInfo.pageCount === 1 ? '' : 's'}.
          {' '}{output === null ? 'The output bound is unknown; the API must validate it before starting.' : 'Output bound: ' + output.toLocaleString() + ' tokens per page, at most ' + (output * pdfInfo.pageCount).toLocaleString() + ' for this PDF.'}</p> : null}
        {jobs.length ? <label className='er-field' htmlFor={id + '-runs'}><span>Recent OCR runs</span>
          <select id={id + '-runs'} value={job?.id ?? ''} disabled={busy || unconfirmed}
            onChange={event => { const next = jobs.find(item => item.id === event.currentTarget.value); if (next && !work.current && !mutationLock.current) { jobVersion.current++; selectedId.current = next.id; setJob(next); setError(''); } }}>
            {!job ? <option value=''>Choose a run</option> : null}
            {jobs.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.state} · {item.modelLabel}</option>)}
          </select>
        </label> : null}
        {job ? <section className='er-ocr__progress' aria-label='OCR progress' aria-live='polite'>
          <h3>{job.modelLabel}</h3>
          <p>{job.state === 'preparing' ? 'Preparing page images. An interrupted preparation must be cancelled before another run.'
            : job.state === 'queued' ? 'OCR is queued.' : job.state === 'running' ? 'Reading PDF pages…'
            : job.state === 'ready' ? 'OCR text is ready for review.' : job.state === 'applied' ? 'OCR text was applied as a new readable revision.'
            : job.state === 'cancelled' ? 'OCR was stopped.' : 'OCR failed.'}</p>
          <p>{job.completedPages.toLocaleString()} of {job.pageCount.toLocaleString()} pages processed.</p>
          {job.error ? <p role='alert'>{job.error}</p> : null}
          {['failed', 'cancelled'].includes(job.state) && job.completedPages > 0 ? <p>Partial output has not been applied. Another attempt requires a new explicit Run.</p> : null}
          {job.baseRevisionId !== revisionId ? <p>This run belongs to an earlier original revision and cannot replace the current source from this dialog.</p> : null}
          {job.state === 'applied' && job.appliedRevisionId ? <button type='button' className='er-button er-button--text' onClick={() => { if (job.appliedRevisionId) onApplied(job.appliedRevisionId); }}>Open applied text</button> : null}
        </section> : null}
        {stage ? <p role='status'>{stage}</p> : null}
        {error ? <p className='er-status er-status--error' role='alert'>{error}</p> : null}
        {unconfirmed ? <p role='status'>This action has not been confirmed. Its run is retained; Check status reads it without creating or starting another run.</p> : null}
        <div className='er-ocr__actions'>
          <button type='button' className='er-button er-button--text' disabled={busy} onClick={checkStatus}>Check run status</button>
          {(job && active(job)) || stage ? <button type='button' className='er-button er-button--tonal' disabled={action !== ''} onClick={() => void stop()}>{action === 'cancel' ? 'Stopping…' : 'Stop OCR'}</button> : null}
          <button type='button' className='er-button er-button--primary' disabled={!canRun} onClick={() => void run()}>Run OCR</button>
        </div>
        {job?.state === 'ready' ? <section className='er-ocr__review' aria-busy={previewLoading}>
          <div className='er-field'>
            <label htmlFor={id + '-text'}>Review and edit OCR text</label>
            <textarea id={id + '-text'} value={previewLoaded ? preview : ''} disabled={!previewLoaded || busy || unconfirmed} onChange={event => setPreview(event.currentTarget.value)} spellCheck={false} />
          </div>
          {previewLoading ? <p role='status'>Loading saved OCR text…</p> : null}
          {previewError ? <div role='alert'><p>{previewError}</p><button type='button' className='er-button er-button--text' onClick={() => setPreviewVersion(value => value + 1)}>Reload saved text</button></div> : null}
          {previewBytes > OCR_LIMITS.previewBytes ? <p role='alert'>The edited text exceeds the readable-text size limit.</p> : null}
          <p>Apply creates a new readable revision. Existing text and citation targets remain available.</p>
          <button type='button' className='er-button er-button--primary' disabled={!previewLoaded || !preview.trim() || previewBytes > OCR_LIMITS.previewBytes || busy || unconfirmed || job.baseRevisionId !== revisionId}
            onClick={() => void apply()}>{action === 'apply' ? 'Applying…' : 'Apply as new readable revision'}</button>
        </section> : null}
        {job && ['queued', 'running'].includes(job.state) ? <p>Closing this dialog leaves the server run active. Stop requests cancellation; an in-flight page may finish before later pages stop.</p> : null}
      </div>
    </dialog>
  </>;
}
