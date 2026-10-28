// K2 Ask: chat + studio views (this slice only). Presentation adapted
// from pinned legacy donor 7c034569 (research run/evidence, model picker
// interaction); no legacy runtime. Types: TurnView from shared/api,
// Citation from citations. Root owns routes, server, schema, CI.
// Read-only WS (snapshot/queued/turn, backoff reconnect, never resubmits);
// only Send POSTs. Scope carry is keyed by project; explicit/empty
// restore from the last turn, project default otherwise. Send waits on chatReady.
// No localStorage. Only Send POSTs; reconnect and route change only
// GET + WS and never resubmit.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Markdown } from './Markdown';
import type { MarkdownReference } from './Markdown';
import type { TurnView } from '../shared/api';
import type { Citation } from '../citations';
import type { Source } from '../shared/api';
import { ModelSettings } from './ModelSettings';
import { ModelPicker } from './ModelPicker';
import type { ModelRoute } from './ModelPicker';
import './chat.css';
type ScopeMode = 'project_default' | 'explicit' | 'empty';
interface ChatRow { readonly id: string; readonly title: string; readonly updatedAt: number; }
interface PageRow { readonly id: string; readonly title: string; readonly updatedAt: number; }
interface QueuedTurn { readonly turnId: string; readonly question: string; }
type SocketStatus = 'connecting' | 'open' | 'closed' | 'error';
const prevScopes = new Map<string, { selected: string[]; touched: boolean }>();
async function apiErrorMessage(res: Response): Promise<string> {
  try { const b = (await res.json()) as { error?: { message?: string } }; if (b.error && b.error.message) return b.error.message; } catch { /* status text */ }
  return 'Request failed with status ' + res.status + '.';
}
async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (res.ok) return (await res.json()) as T;
  throw new Error(await apiErrorMessage(res));
}
function hrefFor(projectId: string, c: Citation): string {
  return '/p/' + encodeURIComponent(projectId) + '/source/' + encodeURIComponent(c.sourceId) + '?revisionId=' + encodeURIComponent(c.revisionId) + '&start=' + c.start + '&end=' + c.end;
}
function citationDisplayLabel(c: Citation): string {
  return c.sourceTitle + ' · ' + c.block + (c.deleted ? ' (deleted)' : '');
}
function collectRefs(projectId: string, cites: readonly Citation[]): MarkdownReference[] {
  const out: MarkdownReference[] = [];
  for (const c of cites) {
    const href = hrefFor(projectId, c);
    const label = citationDisplayLabel(c);
    for (const token of [c.label, '[R' + c.revisionId + ':' + c.block + ']']) {
      if (token !== '' && !out.some((ref) => ref.text === token)) out.push({ text: token, label, href });
    }
  }
  return out;
}
function Cites({ projectId, cites }: { readonly projectId: string; readonly cites: readonly Citation[] }) {
  if (cites.length === 0) return <p className='er-chat__hint'>No citations recorded for this turn.</p>;
  return (<ul className='er-chat__cites'>{cites.map((c) => (<li key={c.revisionId + ':' + c.block + ':' + c.start + ':' + c.end} className='er-chat__cite'><Link to={hrefFor(projectId, c)} title={'Open the cited passage in ' + c.sourceTitle}>{citationDisplayLabel(c)}</Link></li>))}</ul>);
}
export function ChatView() {
  const { projectId, chatId } = useParams();
  const navigate = useNavigate();
  const pid = projectId ?? '';
  const [chats, setChats] = useState<ChatRow[] | undefined>(undefined);
  const [chatsCursor, setChatsCursor] = useState<string | null>(null);
  const [chatsBusy, setChatsBusy] = useState(false);
  const [chatsError, setChatsError] = useState('');
  const [turns, setTurns] = useState<TurnView[]>([]);
  const [turnsError, setTurnsError] = useState('');
  const [sources, setSources] = useState<Source[]>([]);
  const [sourcesError, setSourcesError] = useState('');
  const [models, setModels] = useState<ModelRoute[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState('');
  const [modelsWarnings, setModelsWarnings] = useState<string[]>([]);
  const [modelRoute, setModelRoute] = useState('');
  const [modelSelectionPending, setModelSelectionPending] = useState(false);
  const modelsSeq = useRef(0);
  const modelsAbort = useRef<AbortController | null>(null);
  const [selected, setSelected] = useState<string[]>(() => prevScopes.get(pid)?.selected ?? []);
  const [touched, setTouched] = useState(() => prevScopes.get(pid)?.touched ?? false);
  const [scopeNote, setScopeNote] = useState('');
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState('');
  const [socket, setSocket] = useState<SocketStatus>('connecting');
  const [savingId, setSavingId] = useState('');
  const [saveNote, setSaveNote] = useState('');
  const [queued, setQueued] = useState<QueuedTurn | null>(null);
  const [chatReady, setChatReady] = useState(chatId === undefined);
  const chatRef = useRef(chatId);
  const retryRef = useRef(0);
  useEffect(() => { chatRef.current = chatId; }, [chatId]);
  const mode: ScopeMode = !touched ? 'project_default' : selected.length === 0 ? 'empty' : 'explicit';
  const pidRef = useRef(pid);
  if (pidRef.current !== pid) {
    pidRef.current = pid;
    const carried = prevScopes.get(pid);
    setSelected(carried?.selected ?? []);
    setTouched(carried?.touched ?? false);
  }
  useEffect(() => { prevScopes.set(pid, { selected, touched }); }, [pid, selected, touched]);
  useEffect(() => {
    if (pid === '') return;
    let live = true;
    setChats(undefined); setChatsCursor(null); setChatsBusy(false); setChatsError('');
    void apiJson<{ chats: ChatRow[]; nextCursor: string | null }>('/api/projects/' + encodeURIComponent(pid) + '/chats').then((d) => { if (live) { setChats(d.chats); setChatsCursor(d.nextCursor); setChatsError(''); } }).catch((err: unknown) => { if (live) setChatsError(err instanceof Error ? err.message : 'Could not load chats.'); });
    return () => { live = false; };
  }, [pid]);
  async function moreChats() {
    if (!chatsCursor || chatsBusy) return;
    const requestProject = pid;
    setChatsBusy(true);
    try {
      const data = await apiJson<{ chats: ChatRow[]; nextCursor: string | null }>('/api/projects/' + encodeURIComponent(pid) + '/chats?cursor=' + encodeURIComponent(chatsCursor));
      if (pidRef.current !== requestProject) return;
      setChats((current) => [...(current ?? []), ...data.chats.filter((chat) => !current?.some((existing) => existing.id === chat.id))]);
      setChatsCursor(data.nextCursor); setChatsError('');
    } catch (error) { if (pidRef.current === requestProject) setChatsError(error instanceof Error ? error.message : 'Could not load more chats.'); }
    finally { if (pidRef.current === requestProject) setChatsBusy(false); }
  }
  useEffect(() => {
    if (pid === '') return;
    let live = true;
    void apiJson<{ sources: Source[] }>('/api/projects/' + encodeURIComponent(pid) + '/sources').then((d) => { if (live) { setSources(d.sources); setSourcesError(''); } }).catch((err: unknown) => { if (live) setSourcesError(err instanceof Error ? err.message : 'Could not load sources.'); });
    return () => { live = false; };
  }, [pid]);
  useEffect(() => { if (!touched && sources.length > 0) setSelected(sources.filter((s) => s.enabled !== false).map((s) => s.id)); }, [sources, touched]);
  async function loadModels(): Promise<void> {
    const seq = modelsSeq.current + 1; modelsSeq.current = seq;
    modelsAbort.current?.abort();
    const controller = new AbortController(); modelsAbort.current = controller;
    setModelsLoading(true); setModelsError(''); setModelsWarnings([]);
    try {
      const d = await apiJson<{ models: ModelRoute[]; warnings: string[] }>('/api/models', { signal: controller.signal });
      if (modelsSeq.current !== seq || controller.signal.aborted) return;
      setModels(d.models); setModelsWarnings(d.warnings); setModelsError('');
    } catch (error) {
      if (modelsSeq.current !== seq || controller.signal.aborted) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setModelsError(error instanceof Error ? error.message : 'Could not load model catalog.');
    } finally { if (modelsSeq.current === seq && !controller.signal.aborted) setModelsLoading(false); }
  }
  useEffect(() => { void loadModels(); return () => { modelsAbort.current?.abort(); }; }, []);
  useEffect(() => { void loadChat(); }, [pid, chatId]);
  useEffect(() => { if (chatId === undefined) setChatReady(sources.length > 0); }, [chatId, sources]);
  useEffect(() => {
    if (pid === '' || chatId === undefined) { setSocket('closed'); return; }
    const cid = chatId;
    retryRef.current = 0;
    let live = true;
    let ws: WebSocket | null = null;
    let timer = 0;
    let timerSet = false;
    function connect(): void {
      if (!live) return;
      setSocket('connecting');
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const next = new WebSocket(proto + '://' + window.location.host + '/agents/chat-agent/' + encodeURIComponent(cid) + '?projectId=' + encodeURIComponent(pid));
      ws = next;
      next.onopen = () => { if (live) { setSocket('open'); retryRef.current = 0; } };
      next.onerror = () => { if (live) setSocket('error'); };
      next.onclose = () => {
        if (!live) return;
        setSocket('closed');
        const n = retryRef.current;
        retryRef.current = n + 1;
        const delay = n < 1 ? 1000 : n < 2 ? 2000 : n < 3 ? 5000 : n < 4 ? 10000 : 15000;
        timerSet = true;
        timer = window.setTimeout(connect, delay);
      };
      next.onmessage = (event: MessageEvent) => {
        try {
        const msg = JSON.parse(String(event.data)) as { type: string; turns?: TurnView[]; queued?: QueuedTurn | null; turn?: TurnView };
        if (msg.type === 'snapshot' && Array.isArray(msg.turns)) { setTurns(msg.turns); setQueued(msg.queued ?? null); }
        else if (msg.type === 'queued') setQueued(msg.queued ?? null);
          else if (msg.type === 'turn' && msg.turn !== undefined) setTurns((prev) => (prev.some((t) => t.turnId === (msg.turn as TurnView).turnId) ? prev.map((t) => (t.turnId === (msg.turn as TurnView).turnId ? (msg.turn as TurnView) : t)) : [...prev, msg.turn as TurnView]));
        } catch { /* keep last snapshot; surface stays readable */ }
      };
    }
    connect();
    return () => { live = false; if (timerSet) window.clearTimeout(timer); ws?.close(); };
  }, [pid, chatId]);
  async function loadChat(): Promise<void> {
    if (pid === '' || chatId === undefined) { setTurns([]); return; }
    const cid = chatId;
    setChatReady(false);
    try {
      const d = await apiJson<{ chat: ChatRow; turns: TurnView[]; queued?: QueuedTurn | null }>('/api/projects/' + encodeURIComponent(pid) + '/chats/' + encodeURIComponent(cid));
      if (chatRef.current !== cid) return;
      setTurns(d.turns);
      setTurnsError('');
      if (d.queued !== undefined) setQueued(d.queued);
      const last = d.turns[d.turns.length - 1];
      if (last !== undefined) {
        if (last.scopeMode === 'project_default') setTouched(false);
        else { setTouched(true); setSelected(last.scopeMode === 'empty' ? [] : [...last.sourceIds]); }
      }
      setChatReady(true);
    } catch (err) { if (chatRef.current === cid) setTurnsError(err instanceof Error ? err.message : 'Could not load this chat.'); }
  }
  function toggle(id: string): void { setTouched(true); setSelected((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id])); }
  function useProjectDefault(): void { setTouched(false); setSelected(sources.filter((s) => s.enabled !== false).map((s) => s.id)); }
  function stateLabel(s: TurnView['state']): string {
    if (s === 'started') return 'Answering';
    if (s === 'completed') return 'Answered';
    if (s === 'partial') return 'Partial answer';
    if (s === 'cancelled') return 'Stopped';
    return 'Failed';
  }
  function scopeLabel(s: ScopeMode): string {
    if (s === 'project_default') return 'Project default';
    if (s === 'empty') return 'No sources';
    return 'Selected sources';
  }
  async function saveScopeDefault(): Promise<void> {
    if (pid === '') return;
    setScopeNote('');
    try {
      await apiJson('/api/projects/' + encodeURIComponent(pid) + '/scope', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceIds: selected }) });
      setScopeNote('Project default scope saved.');
    } catch (err) { setScopeNote(err instanceof Error ? err.message : 'Could not save the default scope.'); }
  }
  async function send(): Promise<void> {
    const q = question.trim();
    if (pid === '' || q === '' || busy || !chatReady || queued !== null || modelSelectionPending) return;
    setBusy(true); setSendError(''); setSaveNote('');
    try {
      let target = chatId;
      if (target === undefined) {
        const created = await apiJson<{ chat: ChatRow }>('/api/projects/' + encodeURIComponent(pid) + '/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: q.slice(0, 80) }) });
        target = created.chat.id;
      }
      const body: { turnId: string; question: string; scopeMode: ScopeMode; sourceIds?: string[]; model?: string } = { turnId: crypto.randomUUID(), question: q, scopeMode: mode };
      if (mode === 'explicit') body.sourceIds = [...selected];
      if (modelRoute !== '') body.model = modelRoute;
      await apiJson('/api/projects/' + encodeURIComponent(pid) + '/chats/' + encodeURIComponent(target ?? '') + '/turns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      setQuestion('');
      if (chatId === undefined && target !== undefined) navigate('/p/' + encodeURIComponent(pid) + '/chat/' + encodeURIComponent(target));
    } catch (err) { setSendError(err instanceof Error ? err.message : 'Could not send the question.'); }
    setBusy(false);
  }
  async function stopTurn(turnId: string): Promise<void> {
    if (pid === '' || chatId === undefined) return;
    try { await apiJson('/api/projects/' + encodeURIComponent(pid) + '/chats/' + encodeURIComponent(chatId) + '/turns/' + encodeURIComponent(turnId) + '/stop', { method: 'POST' }); }
    catch (err) { setSendError(err instanceof Error ? err.message : 'Could not stop the turn.'); }
  }
  async function saveTurn(turn: TurnView): Promise<void> {
    if (pid === '' || chatId === undefined || savingId !== '') return;
    setSavingId(turn.turnId); setSaveNote('');
    try {
      await apiJson('/api/projects/' + encodeURIComponent(pid) + '/pages/from-turn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId, turnId: turn.turnId, title: turn.question.slice(0, 120) || 'Saved answer', mutationId: crypto.randomUUID() }) });
      setSaveNote('Saved.');
    } catch (err) { setSaveNote(err instanceof Error ? err.message : 'Could not save the answer.'); }
    setSavingId('');
  }
  if (pid === '') return <p className='er-chat__error' role='alert'>Open this view inside a project route.</p>;
  return (
    <section className='er-chat' aria-label='Chat'>
      <header className='er-chat__head'>
        <h1 className='er-chat__title'>Chat</h1>
        {chatId !== undefined && (socket === 'closed' || socket === 'error')
          ? <p className='er-chat__connection' role='status'>Reconnecting to chat. Messages are not resubmitted.</p> : null}
      </header>
      {chatsError !== '' ? <p className='er-chat__error' role='alert'>{chatsError}</p> : null}
      {chats !== undefined && chats.length > 0 ? (<nav className='er-chat__chats' aria-label='Chats'>
        {chats.map((c) => (<Link key={c.id} className='er-chat__chatlink' to={'/p/' + encodeURIComponent(pid) + '/chat/' + encodeURIComponent(c.id)} aria-current={c.id === chatId ? 'page' : undefined}>{c.title === '' ? 'Untitled chat' : c.title}</Link>))}
        {chatsCursor ? <button className='er-button er-button--text' type='button' disabled={chatsBusy} onClick={() => void moreChats()}>Load more chats</button> : null}
        <Link className='er-chat__chatlink' to={'/p/' + encodeURIComponent(pid) + '/chat'}>New chat</Link>
      </nav>) : null}
      <details className='er-chat__scope' open={chatId === undefined}>
        <summary>Sources ({mode === 'project_default' ? 'project default' : mode === 'empty' ? 'empty — no sources' : selected.length + ' selected'})</summary>
        {sourcesError !== '' ? <p className='er-chat__error' role='alert'>{sourcesError}</p> : null}
        {sources.length === 0 ? <p className='er-chat__hint'>No sources yet. Add them under Sources first.</p> : (<ul className='er-chat__sources'>
          {sources.map((s) => (<li key={s.id}><label><input type='checkbox' checked={selected.includes(s.id)} onChange={() => toggle(s.id)} />{s.title}</label></li>))}
        </ul>)}
        <p className='er-chat__hint'>Default selects every enabled source. An explicit empty selection stays empty; the view never falls back to the whole project.</p>
        <span className='er-chat__actions'><button className='er-button er-button--tonal' type='button' onClick={() => void saveScopeDefault()}>Save selection as project default</button><button className='er-button er-button--text' type='button' onClick={() => useProjectDefault()}>Use project default</button></span>
        {scopeNote !== '' ? <p className='er-chat__hint' role='status'>{scopeNote}</p> : null}
      </details>
      <details className='er-chat__scope'>
        <summary>Project defaults</summary>
        <ModelSettings projectId={pid} />
      </details>
      {turnsError !== '' ? <p className='er-chat__error' role='alert'>{turnsError} <button className='er-button er-button--text' type='button' onClick={() => void loadChat()}>Retry</button></p> : null}
      <ol className='er-chat__turns'>
        {turns.map((t) => (<li key={t.turnId} className='er-chat__turn' data-state={t.state}>
          <p className='er-chat__question'>{t.question}</p>
          <div className='er-chat__answer'>{t.answer === '' ? (t.state === 'started' ? <p className='er-chat__hint' role='status'>Streaming…</p> : <p className='er-chat__hint'>No answer text recorded.</p>) : <Markdown text={t.answer} references={collectRefs(pid, t.citations)} />}</div>
          <p className='er-chat__meta'><span>{stateLabel(t.state)}</span><span>{scopeLabel(t.scopeMode)}</span></p>
          <details className='er-chat__turn-details'>
            <summary>Details</summary>
            <dl>
              {t.contextMode != null ? <div><dt>Context</dt><dd>{t.contextMode}</dd></div> : null}
              {t.firstTokenMs != null ? <div><dt>First token</dt><dd>{t.firstTokenMs} ms</dd></div> : null}
              {t.totalMs != null ? <div><dt>Total time</dt><dd>{t.totalMs} ms</dd></div> : null}
              <div><dt>Tokens</dt><dd>{t.inputTokens == null ? 'Unknown' : t.inputTokens.toLocaleString('en-US')} in{t.cachedTokens != null && t.cachedTokens > 0 ? ' (' + t.cachedTokens.toLocaleString('en-US') + ' cached)' : ''} / {t.outputTokens == null ? 'Unknown' : t.outputTokens.toLocaleString('en-US')} out</dd></div>
              <div><dt>Estimated cost</dt><dd>{t.estimatedCostMicrousd == null ? 'Unknown' : '$' + (t.estimatedCostMicrousd / 1000000).toFixed(4)}</dd></div>
              {t.invalidLabels > 0 ? <div><dt>Invalid labels</dt><dd>{t.invalidLabels}</dd></div> : null}
            </dl>
            <Cites projectId={pid} cites={t.citations} />
          </details>
          <span className='er-chat__actions'>
            {t.state === 'started' ? <button className='er-button er-button--tonal' type='button' onClick={() => void stopTurn(t.turnId)}>Stop</button> : null}
            {(t.state === 'completed' || t.state === 'partial') && chatId !== undefined ? <button className='er-button er-button--text' type='button' disabled={savingId !== ''} onClick={() => void saveTurn(t)}>{savingId === t.turnId ? 'Saving…' : 'Save as page'}</button> : null}
          </span>
        </li>))}
      </ol>
      {turns.length === 0 && chatId !== undefined && turnsError === '' ? <p className='er-chat__hint'>No turns yet. Ask below — sending is the only paid call here.</p> : null}
      {queued !== null ? <p className='er-chat__hint' role='status'>Queued: {queued.question} <button className='er-button er-button--text' type='button' onClick={() => void stopTurn(queued.turnId)}>Cancel queued</button></p> : null}
      <form className='er-chat__composer' onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <div className='er-chat__model'>
          <ModelPicker label='Model' choices={models} value={modelRoute} onChange={setModelRoute}
            loading={modelsLoading} error={modelsError} emptyLabel='Project default' compact warnings={modelsWarnings}
            onRoutePendingChange={setModelSelectionPending} />
        </div>
        <label className='er-chat__asklabel' htmlFor='er-chat-q'>Question</label>
        <textarea id='er-chat-q' value={question} onChange={(e) => setQuestion(e.currentTarget.value)} rows={3} maxLength={4000} placeholder='Ask in Russian or English…' />
        <button className='er-button er-button--primary' type='submit' disabled={busy || question.trim() === '' || !chatReady || queued !== null || modelSelectionPending}>{busy ? 'Sending…' : 'Send'}</button>
      </form>
      {sendError !== '' ? <p className='er-chat__error' role='alert'>{sendError}</p> : null}
      {saveNote !== '' ? <p className='er-chat__hint' role='status'>{saveNote}</p> : null}
    </section>
  );
}
export function StudioView() {
  const { projectId } = useParams();
  const pid = projectId ?? '';
  const [pages, setPages] = useState<PageRow[] | undefined>(undefined);
  const [failure, setFailure] = useState('');
  const [openId, setOpenId] = useState('');
  const [body, setBody] = useState('');
  const [cites, setCites] = useState<Citation[]>([]);
  useEffect(() => {
    if (pid === '') return;
    let live = true;
    void apiJson<{ pages: PageRow[] }>('/api/projects/' + encodeURIComponent(pid) + '/pages').then((d) => { if (live) { setPages(d.pages); setFailure(''); } }).catch((err: unknown) => { if (live) setFailure(err instanceof Error ? err.message : 'Could not load pages.'); });
    return () => { live = false; };
  }, [pid]);
  useEffect(() => {
    if (pid === '' || openId === '') { setBody(''); setCites([]); return; }
    let live = true;
    void apiJson<{ page: { body: string; citations: Citation[] } }>('/api/projects/' + encodeURIComponent(pid) + '/pages/' + encodeURIComponent(openId)).then((d) => { if (live) { setBody(d.page.body); setCites(d.page.citations); } }).catch((err: unknown) => { if (live) setFailure(err instanceof Error ? err.message : 'Could not open the page.'); });
    return () => { live = false; };
  }, [pid, openId]);
  if (pid === '') return <p className='er-chat__error' role='alert'>Open this view inside a project route.</p>;
  return (
    <section className='er-chat' aria-label='Studio'>
      <header className='er-chat__head'><h1 className='er-chat__title'>Studio</h1>
      <p className='er-chat__hint'>Saved answers. Opening a page is storage-only.</p></header>
      {failure !== '' ? <p className='er-chat__error' role='alert'>{failure}</p> : null}
      {pages === undefined ? <p className='er-chat__hint' role='status'>Loading pages…</p> : pages.length === 0 ? <p className='er-chat__hint'>Nothing saved yet. Save an answer from chat.</p> : (<ul className='er-chat__pages'>
        {pages.map((p) => (<li key={p.id}><button className='er-button er-button--text' type='button' onClick={() => setOpenId(p.id)} aria-current={p.id === openId ? 'page' : undefined}>{p.title}</button></li>))}
      </ul>)}
      {openId !== '' && body !== '' ? (<article className='er-chat__page'>
        <div className='er-chat__answer'><Markdown text={body} references={collectRefs(pid, cites)} /></div>
        {cites.length > 0 ? <details className='er-chat__turn-details'><summary>Details</summary><Cites projectId={pid} cites={cites} /></details> : null}
      </article>) : null}
    </section>
  );
}
