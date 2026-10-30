// K2 Ask: project chat and saved-answer Studio views. The parent owns project,
// source selection, active chat routing, and the three-pane workspace. This file
// owns only chat/history presentation and the storage-backed K2 interactions.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Markdown } from './Markdown';
import type { MarkdownReference } from './Markdown';
import type { SourceSelection, TurnView } from '../shared/api';
import type { Citation } from '../citations';
import { ModelSettings } from './ModelSettings';
import { ProposalsInbox } from './Proposals';
import { ModelPicker } from './ModelPicker';
import type { ModelRoute } from './ModelPicker';
import './chat.css';

interface ChatRow { readonly id: string; readonly title: string; readonly updatedAt: number; }
interface PageRow { readonly id: string; readonly title: string; readonly updatedAt: number; }
interface QueuedTurn { readonly turnId: string; readonly question: string; }
type SocketStatus = 'connecting' | 'open' | 'closed' | 'error';

export interface ChatViewProps {
  readonly projectId: string;
  readonly chatId?: string;
  readonly selection: SourceSelection;
  readonly onSelectionChange: (next: SourceSelection) => void;
  readonly onNewChat: () => void;
  readonly onSavedPage: () => void;
  readonly projectAnswerModel?: string | null;
}

export interface StudioViewProps {
  readonly projectId: string;
  readonly refreshKey: number;
}

async function apiErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch { /* use the status when the API body is not readable */ }
  return 'Request failed with status ' + res.status + '.';
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (res.ok) return (await res.json()) as T;
  throw new Error(await apiErrorMessage(res));
}

function hrefFor(projectId: string, citation: Citation): string {
  return '/p/' + encodeURIComponent(projectId) + '/source/' + encodeURIComponent(citation.sourceId)
    + '?revisionId=' + encodeURIComponent(citation.revisionId) + '&start=' + citation.start + '&end=' + citation.end;
}

function citationDisplayLabel(citation: Citation): string {
  return citation.sourceTitle + ' · ' + citation.block + (citation.deleted ? ' (deleted)' : '');
}

function storedModelLabel(route: string, models: readonly ModelRoute[]): string {
  const entry = models.find((model) => model.route === route);
  if (entry !== undefined) return entry.label;
  if (route.startsWith('gateway:')) return route.slice('gateway:'.length);
  if (route.startsWith('workers-ai:')) return route.slice('workers-ai:'.length);
  return route;
}

function turnModelSpan(turn: TurnView, models: readonly ModelRoute[]) {
  if (turn.state === 'started' && turn.tokenLimit == null) return null;
  if (turn.model === '') return null;
  return <span>{storedModelLabel(turn.model, models)}</span>;
}

function collectRefs(projectId: string, citations: readonly Citation[]): MarkdownReference[] {
  const refs: MarkdownReference[] = [];
  for (const citation of citations) {
    const href = hrefFor(projectId, citation);
    const label = citationDisplayLabel(citation);
    for (const token of [citation.label, '[R' + citation.revisionId + ':' + citation.block + ']']) {
      if (token !== '' && !refs.some((ref) => ref.text === token)) refs.push({ text: token, label, href });
    }
  }
  return refs;
}

function Cites({ projectId, cites }: { readonly projectId: string; readonly cites: readonly Citation[] }) {
  if (cites.length === 0) return <p className='er-chat__hint'>No sources cited for this answer.</p>;
  return (
    <ul className='er-card er-chat__cites'>
      {cites.map((citation) => (
        <li key={citation.revisionId + ':' + citation.block + ':' + citation.start + ':' + citation.end} className='er-chat__cite'>
          <Link className='er-chip' to={hrefFor(projectId, citation)} title={'Open the cited passage in ' + citation.sourceTitle}>
            {citationDisplayLabel(citation)}
          </Link>
        </li>
      ))}
    </ul>
  );
}
export function ChatView({
  projectId,
  chatId,
  selection,
  onSelectionChange,
  onNewChat,
  onSavedPage,
  projectAnswerModel,
}: ChatViewProps) {
  const navigate = useNavigate();
  const [chats, setChats] = useState<ChatRow[] | undefined>(undefined);
  const [chatsCursor, setChatsCursor] = useState<string | null>(null);
  const [chatsBusy, setChatsBusy] = useState(false);
  const [chatsError, setChatsError] = useState('');
  const [historyRetry, setHistoryRetry] = useState(0);
  const [turns, setTurns] = useState<TurnView[]>([]);
  const [turnsError, setTurnsError] = useState('');
  const [models, setModels] = useState<ModelRoute[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState('');
  const [modelsWarnings, setModelsWarnings] = useState<string[]>([]);
  const [catalogDefaultModel, setCatalogDefaultModel] = useState<string | null>(null);
  const [modelRoute, setModelRoute] = useState('');
  const [modelSelectionPending, setModelSelectionPending] = useState(false);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState('');
  const [socket, setSocket] = useState<SocketStatus>('connecting');
  const [savingId, setSavingId] = useState('');
  const [saveNote, setSaveNote] = useState('');
  const [queued, setQueued] = useState<QueuedTurn | null>(null);
  const [chatReady, setChatReady] = useState(chatId === undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectSettingsRefreshError, setProjectSettingsRefreshError] = useState('');
  const [refreshedProjectModel, setRefreshedProjectModel] = useState<{ readonly projectId: string; readonly answerModel: string | null } | null>(null);
  const modelsSeq = useRef(0);
  const modelsAbort = useRef<AbortController | null>(null);
  const historySeq = useRef(0);
  const selectionRef = useRef(selection);
  const selectionChangeSeq = useRef(0);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const projectRef = useRef(projectId);
  const chatRef = useRef(chatId);
  const retryRef = useRef(0);
  const settingsDialogRef = useRef<HTMLDialogElement | null>(null);
  const historyRef = useRef<HTMLDetailsElement | null>(null);
  const routeRef = useRef({ projectId, chatId });

  if (selectionRef.current !== selection) {
    selectionRef.current = selection;
    selectionChangeSeq.current += 1;
  }
  onSelectionChangeRef.current = onSelectionChange;
  projectRef.current = projectId;
  chatRef.current = chatId;

  const savedProjectModel = refreshedProjectModel?.projectId === projectId ? refreshedProjectModel.answerModel : undefined;
  const effectiveProjectModel = savedProjectModel !== undefined ? savedProjectModel : projectAnswerModel;
  const inheritedModel = effectiveProjectModel ?? catalogDefaultModel ?? '';

  useEffect(() => {
    if (routeRef.current.projectId === projectId && routeRef.current.chatId === chatId) return;
    routeRef.current = { projectId, chatId };
    setQuestion('');
    setSendError('');
    setSaveNote('');
    setSavingId('');
  }, [projectId, chatId]);

  useEffect(() => {
    setRefreshedProjectModel(null);
    setProjectSettingsRefreshError('');
  }, [projectId, projectAnswerModel]);

  useEffect(() => {
    const sequence = modelsSeq.current + 1;
    modelsSeq.current = sequence;
    modelsAbort.current?.abort();
    const controller = new AbortController();
    modelsAbort.current = controller;
    setModelsLoading(true);
    setModelsError('');
    setModelsWarnings([]);
    void apiJson<{ models: ModelRoute[]; warnings: string[]; defaultModel?: string | null }>('/api/models', { signal: controller.signal })
      .then((data) => {
        if (modelsSeq.current !== sequence || controller.signal.aborted) return;
        setModels(data.models);
        setModelsWarnings(data.warnings);
        setCatalogDefaultModel(data.defaultModel ?? null);
        setModelsError('');
      })
      .catch((error: unknown) => {
        if (modelsSeq.current !== sequence || controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setModelsError(error instanceof Error ? error.message : 'Could not load model catalog.');
      })
      .finally(() => {
        if (modelsSeq.current === sequence && !controller.signal.aborted) setModelsLoading(false);
      });
    return () => { controller.abort(); };
  }, []);

  useEffect(() => {
    let live = true;
    setChats(undefined);
    setChatsCursor(null);
    setChatsBusy(false);
    setChatsError('');
    void apiJson<{ chats: ChatRow[]; nextCursor: string | null }>('/api/projects/' + encodeURIComponent(projectId) + '/chats')
      .then((data) => {
        if (!live) return;
        setChats(data.chats);
        setChatsCursor(data.nextCursor);
        setChatsError('');
      })
      .catch((error: unknown) => {
        if (live) setChatsError(error instanceof Error ? error.message : 'Could not load chat history.');
      });
    return () => { live = false; };
  }, [projectId]);

  async function moreChats(): Promise<void> {
    if (!chatsCursor || chatsBusy) return;
    const requestProject = projectId;
    const requestCursor = chatsCursor;
    setChatsBusy(true);
    try {
      const data = await apiJson<{ chats: ChatRow[]; nextCursor: string | null }>(
        '/api/projects/' + encodeURIComponent(requestProject) + '/chats?cursor=' + encodeURIComponent(requestCursor),
      );
      if (projectRef.current !== requestProject) return;
      setChats((current) => [...(current ?? []), ...data.chats.filter((chat) => !current?.some((existing) => existing.id === chat.id))]);
      setChatsCursor(data.nextCursor);
      setChatsError('');
    } catch (error) {
      if (projectRef.current === requestProject) setChatsError(error instanceof Error ? error.message : 'Could not load more chats.');
    } finally {
      if (projectRef.current === requestProject) setChatsBusy(false);
    }
  }

  useEffect(() => {
    const sequence = historySeq.current + 1;
    historySeq.current = sequence;
    const requestSelectionSequence = selectionChangeSeq.current;
    const requestProject = projectId;
    const requestChat = chatId;
    let live = true;
    setQueued(null);
    setTurns([]);
    setTurnsError('');
    setChatReady(requestChat === undefined);
    if (requestChat !== undefined) {
      void apiJson<{ chat: ChatRow; turns: TurnView[]; queued?: QueuedTurn | null }>(
        '/api/projects/' + encodeURIComponent(requestProject) + '/chats/' + encodeURIComponent(requestChat),
      )
        .then((data) => {
          if (!live || historySeq.current !== sequence || projectRef.current !== requestProject || chatRef.current !== requestChat) return;
          setTurns(data.turns);
          setTurnsError('');
          setQueued(data.queued ?? null);
          const last = data.turns[data.turns.length - 1];
          if (last !== undefined && selectionChangeSeq.current === requestSelectionSequence) {
            onSelectionChangeRef.current({ scopeMode: last.scopeMode, sourceIds: [...last.sourceIds] });
          }
          setChatReady(true);
        })
        .catch((error: unknown) => {
          if (!live || historySeq.current !== sequence || projectRef.current !== requestProject || chatRef.current !== requestChat) return;
          setTurnsError(error instanceof Error ? error.message : 'Could not load this chat.');
          setChatReady(false);
        });
    }
    return () => {
      live = false;
      if (historySeq.current === sequence) historySeq.current += 1;
    };
  }, [projectId, chatId, historyRetry]);

  useEffect(() => {
    if (chatId === undefined) {
      setSocket('closed');
      return;
    }
    const currentProject = projectId;
    const currentChat = chatId;
    retryRef.current = 0;
    let live = true;
    let ws: WebSocket | null = null;
    let timer = 0;
    let timerSet = false;

    function connect(): void {
      if (!live) return;
      setSocket('connecting');
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const next = new WebSocket(
        protocol + '://' + window.location.host + '/agents/chat-agent/' + encodeURIComponent(currentChat)
          + '?projectId=' + encodeURIComponent(currentProject),
      );
      ws = next;
      next.onopen = () => {
        if (live) {
          setSocket('open');
          retryRef.current = 0;
        }
      };
      next.onerror = () => { if (live) setSocket('error'); };
      next.onclose = () => {
        if (!live) return;
        setSocket('closed');
        const attempt = retryRef.current;
        retryRef.current = attempt + 1;
        const delay = attempt < 1 ? 1000 : attempt < 2 ? 2000 : attempt < 3 ? 5000 : attempt < 4 ? 10000 : 15000;
        timerSet = true;
        timer = window.setTimeout(connect, delay);
      };
      next.onmessage = (event: MessageEvent) => {
        if (!live) return;
        try {
          const message = JSON.parse(String(event.data)) as {
            type: string;
            turns?: TurnView[];
            queued?: QueuedTurn | null;
            turn?: TurnView;
          };
          if (message.type === 'snapshot' && Array.isArray(message.turns)) {
            setTurns(message.turns);
            setQueued(message.queued ?? null);
          } else if (message.type === 'queued') {
            setQueued(message.queued ?? null);
          } else if (message.type === 'turn' && message.turn !== undefined) {
            const receivedTurn = message.turn;
            setTurns((previous) => previous.some((turn) => turn.turnId === receivedTurn.turnId)
              ? previous.map((turn) => turn.turnId === receivedTurn.turnId ? receivedTurn : turn)
              : [...previous, receivedTurn]);
          }
        } catch { /* retain the last readable snapshot */ }
      };
    }

    connect();
    return () => {
      live = false;
      if (timerSet) window.clearTimeout(timer);
      ws?.close();
    };
  }, [projectId, chatId]);

  useEffect(() => {
    if (!settingsOpen) return;
    const dialog = settingsDialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, [settingsOpen]);

  async function refreshProjectAnswerModel(): Promise<void> {
    setProjectSettingsRefreshError('');
    try {
      const data = await apiJson<{ project: { answerModel: string | null } }>('/api/projects/' + encodeURIComponent(projectId));
      setRefreshedProjectModel({ projectId, answerModel: data.project.answerModel });
    } catch (error) {
      setProjectSettingsRefreshError(error instanceof Error ? error.message : 'Could not refresh the project default model.');
    }
  }

  function stateLabel(state: TurnView['state']): string {
    if (state === 'started') return 'Answering';
    if (state === 'completed') return 'Answered';
    if (state === 'partial') return 'Partial answer';
    if (state === 'cancelled') return 'Stopped';
    return 'Failed';
  }

  function scopeLabel(scopeMode: TurnView['scopeMode']): string {
    if (scopeMode === 'project_default') return 'Project default';
    if (scopeMode === 'empty') return 'No sources';
    return 'Selected sources';
  }

  function startNewChat(): void {
    onNewChat();
    if (historyRef.current !== null) historyRef.current.open = false;
    navigate('/p/' + encodeURIComponent(projectId) + '/chat');
  }

  async function send(): Promise<void> {
    const nextQuestion = question.trim();
    if (nextQuestion === '' || busy || !chatReady || queued !== null || modelSelectionPending) return;
    setBusy(true);
    setSendError('');
    setSaveNote('');
    try {
      let targetChat = chatId;
      if (targetChat === undefined) {
        const created = await apiJson<{ chat: ChatRow }>('/api/projects/' + encodeURIComponent(projectId) + '/chats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: nextQuestion.slice(0, 80) }),
        });
        targetChat = created.chat.id;
        setChats((current) => [created.chat, ...(current ?? []).filter((chat) => chat.id !== created.chat.id)]);
      }
      const body: { turnId: string; question: string; scopeMode: TurnView['scopeMode']; sourceIds?: string[]; model?: string } = {
        turnId: crypto.randomUUID(),
        question: nextQuestion,
        scopeMode: selection.scopeMode,
      };
      if (selection.scopeMode === 'explicit') body.sourceIds = [...selection.sourceIds];
      if (modelRoute !== '') body.model = modelRoute;
      await apiJson('/api/projects/' + encodeURIComponent(projectId) + '/chats/' + encodeURIComponent(targetChat) + '/turns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setQuestion('');
      if (chatId === undefined) {
        navigate('/p/' + encodeURIComponent(projectId) + '/chat/' + encodeURIComponent(targetChat));
      }
    } catch (error) {
      setSendError(error instanceof Error ? error.message : 'Could not send the question.');
    } finally {
      setBusy(false);
    }
  }

  async function stopTurn(turnId: string): Promise<void> {
    if (chatId === undefined) return;
    try {
      await apiJson('/api/projects/' + encodeURIComponent(projectId) + '/chats/' + encodeURIComponent(chatId)
        + '/turns/' + encodeURIComponent(turnId) + '/stop', { method: 'POST' });
    } catch (error) {
      setSendError(error instanceof Error ? error.message : 'Could not stop the turn.');
    }
  }

  async function saveTurn(turn: TurnView): Promise<void> {
    if (chatId === undefined || savingId !== '') return;
    setSavingId(turn.turnId);
    setSaveNote('');
    try {
      await apiJson('/api/projects/' + encodeURIComponent(projectId) + '/pages/from-turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId,
          turnId: turn.turnId,
          title: turn.question.slice(0, 120) || 'Saved answer',
          mutationId: crypto.randomUUID(),
        }),
      });
      setSaveNote('Saved.');
      onSavedPage();
    } catch (error) {
      setSaveNote(error instanceof Error ? error.message : 'Could not save the answer.');
    } finally {
      setSavingId('');
    }
  }

  return (
    <section className='er-chat' aria-label='Chat'>
      <header className='er-chat__head'>
        <div className='er-chat__head-title'>
          <h1 className='er-chat__title'>Chat</h1>
          {chatId !== undefined && (socket === 'closed' || socket === 'error')
            ? <p className='er-chat__connection' role='status'>Reconnecting to chat…</p>
            : null}
        </div>
        <div className='er-chat__head-actions'>
          <details className='er-chat__history' ref={historyRef}>
            <summary className='er-button er-button--tonal er-chat__history-trigger'>History</summary>
            <div className='er-chat__history-menu'>
              <nav aria-label='Chat history'>
                {chatsError !== '' ? (
                  <p className='er-chat__error' role='alert'>{chatsError}</p>
                ) : chats === undefined ? (
                  <p className='er-chat__hint' role='status'>Loading chat history…</p>
                ) : chats.length === 0 ? (
                  <p className='er-chat__hint'>No saved chats yet.</p>
                ) : (
                  <ul className='er-chat__history-list'>
                    {chats.map((chat) => (
                      <li key={chat.id}>
                        <Link
                          className='er-chat__history-link'
                          to={'/p/' + encodeURIComponent(projectId) + '/chat/' + encodeURIComponent(chat.id)}
                          aria-current={chat.id === chatId ? 'page' : undefined}
                          onClick={() => { if (historyRef.current !== null) historyRef.current.open = false; }}
                        >
                          {chat.title === '' ? 'Untitled chat' : chat.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                {chatsCursor !== null ? (
                  <button className='er-button er-button--text' type='button' disabled={chatsBusy} onClick={() => void moreChats()}>
                    {chatsBusy ? 'Loading…' : 'Load more chats'}
                  </button>
                ) : null}
              </nav>
              <button className='er-button er-button--text' type='button' onClick={startNewChat}>New chat</button>
            </div>
          </details>
          <button className='er-button er-button--tonal' type='button' onClick={() => setSettingsOpen(true)}>
            Project settings
          </button>
        </div>
      </header>

      {settingsOpen ? (
        <dialog
          ref={settingsDialogRef}
          className='er-dialog er-chat__settings'
          aria-labelledby='er-chat-settings-title'
          onClose={() => setSettingsOpen(false)}
        >
          <div className='er-chat__settings-head'>
            <h2 className='er-dialog__title' id='er-chat-settings-title'>Project settings</h2>
            <button className='er-button er-button--text' type='button' onClick={() => settingsDialogRef.current?.close()}>
              Close
            </button>
          </div>
          {projectSettingsRefreshError !== '' ? <p className='er-chat__error' role='alert'>{projectSettingsRefreshError}</p> : null}
          <ModelSettings projectId={projectId} onSaved={refreshProjectAnswerModel} />
        </dialog>
      ) : null}

      <div className='er-chat__conversation'>
        {turnsError !== '' ? (
          <p className='er-chat__error' role='alert'>
            {turnsError}{' '}
            <button className='er-button er-button--text' type='button' onClick={() => setHistoryRetry((retry) => retry + 1)}>
              Retry
            </button>
          </p>
        ) : null}
        {chatId !== undefined && !chatReady && turnsError === ''
          ? <p className='er-chat__hint' role='status'>Loading this conversation…</p>
          : null}
        {turns.length === 0 && chatReady && turnsError === ''
          ? <p className='er-chat__hint'>Ask a question to start this conversation.</p>
          : null}
        <ol className='er-chat__turns'>
          {turns.map((turn) => (
            <li key={turn.turnId} className='er-chat__turn' data-state={turn.state}>
              <p className='er-chat__question'>{turn.question}</p>
              <div className='er-chat__answer'>
                {turn.answer === ''
                  ? (turn.state === 'started'
                    ? <p className='er-chat__hint' role='status'>Preparing your answer…</p>
                    : <p className='er-chat__hint'>No answer available.</p>)
                  : <Markdown text={turn.answer} references={collectRefs(projectId, turn.citations)} warnings={turn.warnings ?? []} />}
              </div>
              <p className='er-chat__meta'>
                <span>{stateLabel(turn.state)}</span>
                <span>{scopeLabel(turn.scopeMode)}</span>
                {turnModelSpan(turn, models)}
              </p>
              <details className='er-chat__turn-details'>
                <summary>Sources</summary>
                <Cites projectId={projectId} cites={turn.citations} />
              </details>
              <span className='er-chat__actions'>
                {turn.state === 'started'
                  ? <button className='er-button er-button--tonal' type='button' onClick={() => void stopTurn(turn.turnId)}>Stop</button>
                  : null}
                {(turn.state === 'completed' || turn.state === 'partial') && chatId !== undefined
                  ? (
                    <button className='er-button er-button--text' type='button' disabled={savingId !== ''} onClick={() => void saveTurn(turn)}>
                      {savingId === turn.turnId ? 'Saving…' : 'Save as page'}
                    </button>
                  )
                  : null}
              </span>
            </li>
          ))}
        </ol>
      </div>

      <form className='er-chat__composer' onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <div className='er-chat__model'>
          <ModelPicker
            label='Model'
            choices={models}
            value={modelRoute}
            onChange={setModelRoute}
            defaultRoute={inheritedModel}
            loading={modelsLoading}
            error={modelsError}
            emptyLabel='Project default'
            compact
            warnings={modelsWarnings}
            onRoutePendingChange={setModelSelectionPending}
          />
        </div>
        <label className='er-field er-chat__question-field' htmlFor='er-chat-q'>
          <span className='er-chat__asklabel'>Question</span>
          <textarea
            id='er-chat-q'
            value={question}
            onChange={(event) => setQuestion(event.currentTarget.value)}
            rows={3}
            maxLength={4000}
            placeholder='Ask in Russian or English…'
          />
        </label>
        <button
          className='er-button er-button--primary'
          type='submit'
          disabled={busy || question.trim() === '' || !chatReady || queued !== null || modelSelectionPending}
        >
          {busy ? 'Sending…' : 'Send'}
        </button>
        {queued !== null ? (
          <p className='er-chat__hint' role='status'>
            Next question: {queued.question}{' '}
            <button className='er-button er-button--text' type='button' onClick={() => void stopTurn(queued.turnId)}>Cancel question</button>
          </p>
        ) : null}
        {sendError !== '' ? <p className='er-chat__error' role='alert'>{sendError}</p> : null}
        {saveNote !== '' ? <p className='er-chat__hint' role='status'>{saveNote}</p> : null}
      </form>
    </section>
  );
}

export function StudioView({ projectId, refreshKey }: StudioViewProps) {
  const [proposalRefresh, setProposalRefresh] = useState(0);
  const [pages, setPages] = useState<PageRow[] | undefined>(undefined);
  const [failure, setFailure] = useState('');
  const [openId, setOpenId] = useState('');
  const [body, setBody] = useState('');
  const [cites, setCites] = useState<Citation[]>([]);
  const [pageLoading, setPageLoading] = useState(false);

  useEffect(() => {
    let live = true;
    setPages(undefined);
    setFailure('');
    void apiJson<{ pages: PageRow[] }>('/api/projects/' + encodeURIComponent(projectId) + '/pages')
      .then((data) => {
        if (!live) return;
        setPages(data.pages);
        setFailure('');
      })
      .catch((error: unknown) => {
        if (live) setFailure(error instanceof Error ? error.message : 'Could not load saved pages.');
      });
    return () => { live = false; };
  }, [projectId, refreshKey, proposalRefresh]);

  useEffect(() => {
    if (openId === '') {
      setBody('');
      setCites([]);
      setPageLoading(false);
      return;
    }
    let live = true;
    setBody('');
    setCites([]);
    setFailure('');
    setPageLoading(true);
    void apiJson<{ page: { body: string; citations: Citation[] } }>(
      '/api/projects/' + encodeURIComponent(projectId) + '/pages/' + encodeURIComponent(openId),
    )
      .then((data) => {
        if (!live) return;
        setBody(data.page.body);
        setCites(data.page.citations);
      })
      .catch((error: unknown) => {
        if (live) setFailure(error instanceof Error ? error.message : 'Could not open the saved page.');
      })
      .finally(() => {
        if (live) setPageLoading(false);
      });
    return () => { live = false; };
  }, [projectId, openId, proposalRefresh]);

  return (
    <section className='er-chat er-chat--studio' aria-label='Studio'>
      <header className='er-chat__head'>
        <div className='er-chat__head-title'>
          <h1 className='er-chat__title'>Studio</h1>
          <p className='er-chat__hint'>Answers you saved from chat.</p>
        </div>
        <ProposalsInbox projectId={projectId} onAccepted={(pageId) => {
          setProposalRefresh(value => value + 1);
          setOpenId(pageId);
        }} />
      </header>
      <div className='er-chat__studio-content'>
        <section className='er-chat__studio-list' aria-label='Saved pages'>
          {failure !== '' ? <p className='er-chat__error' role='alert'>{failure}</p> : null}
          {pages === undefined
            ? <p className='er-chat__hint' role='status'>Loading saved pages…</p>
            : pages.length === 0
              ? <p className='er-chat__hint'>Nothing saved yet. Save an answer from chat.</p>
              : (
                <ul className='er-chat__pages'>
                  {pages.map((page) => (
                    <li key={page.id}>
                      <button
                        className='er-button er-button--text'
                        type='button'
                        onClick={() => setOpenId(page.id)}
                        aria-current={page.id === openId ? 'page' : undefined}
                      >
                        {page.title}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
        </section>
        <article className='er-card er-chat__page er-chat__studio-reader'>
          {pageLoading
            ? <p className='er-chat__hint' role='status'>Loading saved answer…</p>
            : body !== ''
              ? (
                <>
                  <div className='er-chat__answer'><Markdown text={body} references={collectRefs(projectId, cites)} /></div>
                  {cites.length > 0 ? (
                    <details className='er-chat__turn-details'>
                      <summary>Sources</summary>
                      <Cites projectId={projectId} cites={cites} />
                    </details>
                  ) : null}
                </>
              )
              : <p className='er-chat__hint'>Select a saved answer to read it.</p>}
        </article>
      </div>
    </section>
  );
}
