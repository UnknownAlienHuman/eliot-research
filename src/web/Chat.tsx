// K2 Ask: project chat and saved-answer Studio views. The parent owns project,
// source selection, active chat routing, and the three-pane workspace. This file
// owns only chat/history presentation and the storage-backed K2 interactions.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Markdown } from './Markdown';
import type { MarkdownReference } from './Markdown';
import type { ChatSnapshotState, SourceSelection, TurnPage, TurnView } from '../shared/api';
import { advanceHistoryHead, mergeTurnHistory } from './chat-history';
import type { HistoryHead } from './chat-history';
import type { Citation } from '../citations';
import { ModelSettings } from './ModelSettings';
import { ProposalsInbox } from './Proposals';
import { ModelPicker } from './ModelPicker';
import type { ModelRoute } from './ModelPicker';
import './chat.css';

interface ChatRow { readonly id: string; readonly title: string; readonly updatedAt: number; }
import type { PageList, PageSummary, SavedPage } from '../pages';
import { mergeStudioPages, newerPage, pageSummary } from './studio-pages';
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
  const turnsRef = useRef<TurnView[]>([]);
  const [turnsError, setTurnsError] = useState('');
  const [turnsCursor, setTurnsCursor] = useState<string | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderError, setOlderError] = useState('');
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
  const turnsRoute = useRef<{ projectId: string; chatId?: string } | null>(null);
  const olderRequest = useRef(0);
  const olderAbort = useRef<AbortController | null>(null);
  const headSequence = useRef(0);
  const headWindow = useRef<HistoryHead | null>(null);
  const stateVersion = useRef(0);
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const prependScroll = useRef<{ element: HTMLElement | null; offset: number; top: number } | null>(null);

  function mergeTurns(incoming: readonly TurnView[]): void {
    const merged = mergeTurnHistory(turnsRef.current, incoming);
    turnsRef.current = merged;
    setTurns(merged);
  }
  function mergeSnapshotState(snapshot: ChatSnapshotState): void {
    if (snapshot.stateVersion < stateVersion.current) return;
    stateVersion.current = snapshot.stateVersion;
    setQueued(snapshot.queued);
    setTurnsError(snapshot.settlementError ?? '');
  }

  function mergeHead(page: TurnPage): void {
    const advance = advanceHistoryHead(headWindow.current, page);
    // Arrival order is not read order: an old socket snapshot can follow a
    // newer HTTP head. Only an advancing head may move the page boundary.
    if (advance) {
      if (advance.rewind) {
        olderRequest.current++;
        olderAbort.current?.abort();
        setOlderBusy(false); setOlderError('');
        setTurnsCursor(page.nextCursor);
      }
      headWindow.current = advance.head;
    }
    mergeTurns(page.turns);
  }

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
    const requestHead = headSequence.current;
    const sameRoute = turnsRoute.current?.projectId === projectId && turnsRoute.current.chatId === chatId;
    turnsRoute.current = { projectId, ...(chatId ? { chatId } : {}) };
    const abort = new AbortController();
    let live = true;
    olderRequest.current++;
    olderAbort.current?.abort();
    setOlderBusy(false);
    setOlderError('');
    if (!sameRoute) {
      setQueued(null);
      setTurns([]);
      turnsRef.current = [];
      headWindow.current = null;
      stateVersion.current = 0;
      setTurnsCursor(null);
      prependScroll.current = null;
    }
    setTurnsError('');
    setChatReady(requestChat === undefined);
    if (requestChat !== undefined) {
      void apiJson<TurnPage & ChatSnapshotState & { chat: ChatRow }>(
        '/api/projects/' + encodeURIComponent(requestProject) + '/chats/' + encodeURIComponent(requestChat),
        { signal: abort.signal },
      )
        .then((data) => {
          if (!live || historySeq.current !== sequence || projectRef.current !== requestProject || chatRef.current !== requestChat) return;
          mergeHead(data);
          mergeSnapshotState(data);
          const last = turnsRef.current.at(-1);
          if (last !== undefined && selectionChangeSeq.current === requestSelectionSequence) {
            onSelectionChangeRef.current({ scopeMode: last.scopeMode, sourceIds: [...last.sourceIds] });
          }
          setChatReady(true);
        })
        .catch((error: unknown) => {
          if (!live || historySeq.current !== sequence || projectRef.current !== requestProject || chatRef.current !== requestChat) return;
          if (headSequence.current !== requestHead) return;
          setTurnsError(error instanceof Error ? error.message : 'Could not load this chat.');
          setChatReady(false);
        });
    }
    return () => {
      live = false;
      abort.abort();
      olderAbort.current?.abort();
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
        if (!live || projectRef.current !== currentProject || chatRef.current !== currentChat || next !== ws) return;
        setSocket('closed');
        const attempt = retryRef.current;
        retryRef.current = attempt + 1;
        const delay = attempt < 1 ? 1000 : attempt < 2 ? 2000 : attempt < 3 ? 5000 : attempt < 4 ? 10000 : 15000;
        timerSet = true;
        timer = window.setTimeout(connect, delay);
      };
      next.onmessage = (event: MessageEvent) => {
        if (!live || projectRef.current !== currentProject || chatRef.current !== currentChat || next !== ws) return;
        try {
          const message = JSON.parse(String(event.data)) as {
            type: string;
            turns?: TurnView[];
            queued?: QueuedTurn | null;
            turn?: TurnView;
            settlementError?: string | null;
            nextCursor?: string | null;
            stateVersion?: number;
          };
          if (message.type === 'snapshot' && Array.isArray(message.turns)) {
            headSequence.current++;
            mergeHead({ turns: message.turns, nextCursor: message.nextCursor ?? null });
            setChatReady(true);
            mergeSnapshotState({ stateVersion: message.stateVersion ?? 0, queued: message.queued ?? null, settlementError: message.settlementError ?? null });
          } else if (message.type === 'queued') {
            mergeSnapshotState({ stateVersion: message.stateVersion ?? 0, queued: message.queued ?? null, settlementError: message.settlementError ?? null });
          } else if (message.type === 'turn' && message.turn !== undefined) {
            const receivedTurn = message.turn;
            mergeTurns([receivedTurn]);
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

  useLayoutEffect(() => {
    const container = conversationRef.current, anchor = prependScroll.current;
    if (container && anchor) {
      if (anchor.element?.isConnected && container.contains(anchor.element))
        container.scrollTop += anchor.element.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset;
      else container.scrollTop = anchor.top;
    }
    prependScroll.current = null;
  }, [turns]);

  async function moreTurns(): Promise<void> {
    if (!chatId || !turnsCursor || olderBusy) return;
    const request = ++olderRequest.current, project = projectId, chat = chatId;
    const abort = new AbortController(); olderAbort.current = abort;
    setOlderBusy(true); setOlderError('');
    try {
      const data = await apiJson<TurnPage>('/api/projects/' + encodeURIComponent(project) + '/chats/' + encodeURIComponent(chat)
        + '/turns?cursor=' + encodeURIComponent(turnsCursor), { signal: abort.signal });
      if (olderRequest.current !== request || projectRef.current !== project || chatRef.current !== chat) return;
      const element = conversationRef.current;
      if (element) {
        const viewport = element.getBoundingClientRect();
        const anchor = [...element.querySelectorAll<HTMLElement>('[data-turn-id]')].find((turn) => {
          const bounds = turn.getBoundingClientRect(); return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
        }) ?? null;
        prependScroll.current = { element: anchor, offset: anchor ? anchor.getBoundingClientRect().top - viewport.top : 0, top: element.scrollTop };
      }
      mergeTurns(data.turns);
      setTurnsCursor(data.nextCursor);
    } catch (error) {
      if (olderRequest.current === request && projectRef.current === project && chatRef.current === chat)
        setOlderError(error instanceof Error ? error.message : 'Could not load earlier messages.');
    } finally { if (olderRequest.current === request) setOlderBusy(false); }
  }

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

      <div className='er-chat__conversation' ref={conversationRef}>
        {turnsCursor !== null ? <button className='er-button er-button--text' type='button' disabled={olderBusy} onClick={() => void moreTurns()}>
          {olderBusy ? 'Loading earlier messages…' : 'Load earlier messages'}
        </button> : null}
        {olderError !== '' ? <p className='er-chat__error' role='alert'>{olderError} Retry loading earlier messages.</p> : null}
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
            <li key={turn.turnId} className='er-chat__turn' data-state={turn.state} data-turn-id={turn.turnId}>
              <p className='er-chat__question'>{turn.question}</p>
              <div className='er-chat__answer'>
                {turn.answer === ''
                  ? (turn.state === 'started'
                    ? <p className='er-chat__hint' role='status'>Preparing your answer…</p>
                    : <p className='er-chat__hint'>No answer available.</p>)
                  : <Markdown text={turn.answer} references={collectRefs(projectId, turn.citations)} />}
              </div>
              {turn.error ? <p className='er-chat__hint' role='status'>{turn.error}</p> : null}
              {turn.settlementError ? <p className='er-chat__hint' role='status'>{turn.settlementError}</p> : null}
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
  const [scan, setScan] = useState(0);
  const [pages, setPages] = useState<PageSummary[] | undefined>(undefined);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState('');
  const [selection, setSelection] = useState<{ projectId: string; pageId: string } | null>(null);
  const openId = selection?.projectId === projectId ? selection.pageId : '';
  const [reader, setReader] = useState<{ projectId: string; page: SavedPage } | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailRetry, setDetailRetry] = useState(0);
  const [pageLoading, setPageLoading] = useState(false);
  const projectRef = useRef(projectId), selectedRef = useRef(openId);
  const pool = useRef<{ projectId: string; pages: PageSummary[] }>({ projectId, pages: [] });
  const detail = useRef<{ projectId: string; page: SavedPage; refresh: string } | null>(null);
  const listSequence = useRef(0), detailSequence = useRef(0);
  const listAbort = useRef<AbortController | null>(null), listLock = useRef(false);
  projectRef.current = projectId; selectedRef.current = openId;
  const visiblePages = pool.current.projectId === projectId ? pages : undefined;
  const hint = visiblePages?.find((page) => page.id === openId);
  const refresh = refreshKey + ':' + scan + ':' + detailRetry;

  function receivePages(incoming: readonly PageSummary[], replace = false): void {
    let next = mergeStudioPages(replace ? [] : pool.current.pages, incoming);
    const known = detail.current;
    if (known?.projectId === projectId && next.some((page) => page.id === known.page.id)) next = mergeStudioPages(next, [pageSummary(known.page)]);
    pool.current = { projectId, pages: next }; setPages(next);
  }

  useEffect(() => {
    const sequence = ++listSequence.current, project = projectId, abort = new AbortController();
    listAbort.current?.abort(); listAbort.current = abort; listLock.current = true;
    pool.current = { projectId: project, pages: [] };
    setPages(undefined); setCursor(null); setListBusy(true); setListError('');
    void apiJson<PageList>('/api/projects/' + encodeURIComponent(project) + '/pages', { signal: abort.signal })
      .then((data) => {
        if (listSequence.current !== sequence || projectRef.current !== project) return;
        receivePages(data.pages, true); setCursor(data.nextCursor);
      })
      .catch((error: unknown) => {
        if (listSequence.current === sequence && projectRef.current === project)
          setListError(error instanceof Error ? error.message : 'Could not load saved pages.');
      })
      .finally(() => {
        if (listSequence.current === sequence && projectRef.current === project) { listLock.current = false; setListBusy(false); }
      });
    return () => { listSequence.current++; listAbort.current?.abort(); };
  }, [projectId, refreshKey, scan]);

  async function morePages(): Promise<void> {
    if (!cursor || listLock.current) return;
    const sequence = ++listSequence.current, project = projectId, abort = new AbortController();
    listAbort.current = abort; listLock.current = true; setListBusy(true); setListError('');
    try {
      const data = await apiJson<PageList>('/api/projects/' + encodeURIComponent(project) + '/pages?cursor=' + encodeURIComponent(cursor), { signal: abort.signal });
      if (listSequence.current !== sequence || projectRef.current !== project) return;
      receivePages(data.pages); setCursor(data.nextCursor);
    } catch (error) {
      if (listSequence.current === sequence && projectRef.current === project)
        setListError(error instanceof Error ? error.message : 'Could not load more pages.');
    } finally {
      if (listSequence.current === sequence && projectRef.current === project) { listLock.current = false; setListBusy(false); }
    }
  }

  useEffect(() => {
    if (!openId) { detail.current = null; setReader(null); setPageLoading(false); setDetailError(''); return; }
    const known = detail.current;
    if (known?.projectId === projectId && known.page.id === openId && known.refresh === refresh
      && (!hint || known.page.headRevisionNo > hint.headRevisionNo
        || (known.page.headRevisionNo === hint.headRevisionNo && (known.page.freshness === 'stale' || hint.freshness === 'current')))) { setPageLoading(false); return; }
    const sequence = ++detailSequence.current, project = projectId, id = openId, abort = new AbortController();
    setPageLoading(true); setDetailError('');
    void apiJson<{ page: SavedPage }>('/api/projects/' + encodeURIComponent(project) + '/pages/' + encodeURIComponent(id), { signal: abort.signal })
      .then((data) => {
        if (detailSequence.current !== sequence || projectRef.current !== project || selectedRef.current !== id) return;
        const previous = detail.current;
        const value = previous?.projectId === project && previous.page.id === id && newerPage(previous.page, data.page) === previous.page ? previous.page : data.page;
        detail.current = { projectId: project, page: value, refresh };
        setReader({ projectId: project, page: value });
        if (pool.current.projectId === project && pool.current.pages.some((page) => page.id === id)) receivePages([pageSummary(value)]);
      })
      .catch((error: unknown) => {
        if (detailSequence.current === sequence && projectRef.current === project && selectedRef.current === id)
          setDetailError(error instanceof Error ? error.message : 'Could not open the saved page.');
      })
      .finally(() => {
        if (detailSequence.current === sequence && projectRef.current === project && selectedRef.current === id) setPageLoading(false);
      });
    return () => { abort.abort(); detailSequence.current++; };
  }, [projectId, openId, refresh, hint?.headRevisionNo, hint?.freshness]);

  const selected = reader?.projectId === projectId && reader.page.id === openId ? reader.page : null;
  const readable = selected && (!hint || selected.headRevisionNo >= hint.headRevisionNo) ? selected : null;
  return (
    <section className='er-chat er-chat--studio' aria-label='Studio'>
      <header className='er-chat__head'>
        <div className='er-chat__head-title'><h1 className='er-chat__title'>Studio</h1><p className='er-chat__hint'>Answers you saved from chat. Refresh to see changes from other sessions.</p></div>
        <div className='er-chat__head-actions'>
          <button className='er-button er-button--text' type='button' disabled={listBusy} onClick={() => setScan((value) => value + 1)}>Refresh pages</button>
          <ProposalsInbox projectId={projectId} onAccepted={(pageId) => { setSelection({ projectId, pageId }); setScan((value) => value + 1); }} />
        </div>
      </header>
      <div className='er-chat__studio-content'>
        <section className='er-chat__studio-list' aria-label='Saved pages' aria-busy={listBusy}>
          {listError ? <p className='er-chat__error' role='alert'>{listError} <button className='er-button er-button--text' type='button'
            onClick={() => cursor ? void morePages() : setScan((value) => value + 1)}>Retry pages</button></p> : null}
          {visiblePages === undefined ? <p className='er-chat__hint' role='status'>{listBusy ? 'Loading saved pages.' : 'Saved pages are unavailable.'}</p>
            : visiblePages.length === 0 ? <p className='er-chat__hint'>Nothing saved yet. Save an answer from chat.</p>
              : <ul className='er-chat__pages'>{visiblePages.map((page) => <li key={page.id}>
                <button className='er-button er-button--text' type='button' onClick={() => setSelection({ projectId, pageId: page.id })}
                  aria-current={page.id === openId ? 'page' : undefined} aria-describedby={'page-freshness-' + page.id}>{page.title}</button>
                <span className='er-chip' id={'page-freshness-' + page.id}>{page.freshness === 'stale' ? 'Stale' : 'Current'}</span>
              </li>)}</ul>}
          {cursor ? <button className='er-button er-button--text' type='button' disabled={listBusy} onClick={() => void morePages()}>
            {listBusy ? 'Loading more pages…' : 'Load more pages'}</button> : null}
        </section>
        <article className='er-card er-chat__page er-chat__studio-reader' aria-label='Selected saved page' aria-busy={pageLoading}>
          {selected ? <h2>{selected.title}</h2> : null}
          {pageLoading ? <p className='er-chat__hint' role='status'>Updating saved page.</p> : null}
          {detailError ? <p className='er-chat__error' role='alert'>{detailError} <button className='er-button er-button--text' type='button'
            onClick={() => setDetailRetry((value) => value + 1)}>Retry page</button></p> : null}
          {readable ? <>
            {!pageLoading ? <p className='er-chat__hint' role='status'>{detailError ? 'Freshness could not be checked.' : readable.freshness === 'stale'
              ? 'Stale. Sources changed or are no longer available.' : 'Current.'}</p> : null}
            <div className='er-chat__answer'><Markdown text={readable.body} references={collectRefs(projectId, readable.citations)} /></div>
            {readable.citations.length > 0 ? <details className='er-chat__turn-details'><summary>Sources</summary><Cites projectId={projectId} cites={readable.citations} /></details> : null}
          </> : !pageLoading && !detailError ? <p className='er-chat__hint'>Select a saved answer to read it.</p> : null}
        </article>
      </div>
    </section>
  );
}
