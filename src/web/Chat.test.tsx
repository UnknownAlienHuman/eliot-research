// @vitest-environment jsdom
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { act, StrictMode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveAnswer } from '../pages';
import type { SourceSelection, TurnView } from '../shared/api';
import { ChatView } from './Chat';

vi.mock('./ModelPicker', () => ({ ModelPicker: () => null }));
// Node 22.18 omits sqlite from builtinModules; load the real host module outside the jsdom transform.
const sqlite = process.getBuiltinModule('node:sqlite') as { DatabaseSync: typeof DatabaseSync };
const citation = { revisionId: 'r1', sourceId: 's1', block: 1, start: 0, end: 20, sourceTitle: 'Evidence', deleted: false, label: '[Rr1:1]' };
const turn = (id: string): TurnView => ({ turnId: id, question: 'Question ' + id, answer: 'Saved evidence [Rr1:1]', state: 'completed',
  model: 'fixture', scopeMode: 'explicit', revisionIds: ['r1'], sourceIds: ['s1'], citations: [citation], invalidLabels: 0,
  inputTokens: null, cachedTokens: null, outputTokens: null, tokenLimit: null, firstTokenMs: null, totalMs: null, error: null });
const owner = { type: 'owner', id: 'owner', authentication: 'access' } as const;
type Statement = { sql: string; args: SQLInputValue[]; bind(...args: SQLInputValue[]): Statement; first(): Promise<unknown>; run(): Promise<unknown> };
let root: Root, host: HTMLDivElement, router: ReturnType<typeof createMemoryRouter>, db: DatabaseSync;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function save(id: string) {
  const button = host.querySelector<HTMLButtonElement>(`[data-turn-id="${id}"] button`);
  if (!button) throw new Error('Missing Save action for ' + id);
  await act(async () => { button.click(); }); await settle();
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: (entries: unknown[]) => void) {}
    observe() { this.callback([{ contentRect: { width: 800, height: 600 } }]); }
    disconnect() {}
  });
  vi.stubGlobal('WebSocket', class { close() {} });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  db = new sqlite.DatabaseSync(':memory:');
  for (const file of readdirSync('migrations').filter(s => /^\d+.*\.sql$/.test(s)).sort())
    db.exec(readFileSync('migrations/' + file, 'utf8'));
  db.exec(`INSERT INTO project(id,title,created_at,updated_at) VALUES('p1','Project',1,1);
    INSERT INTO source(id,title,kind,created_by,created_at,updated_at) VALUES('s1','Evidence','text','owner',1,1);
    INSERT INTO source_revision(id,source_id,revision_no,readable_state,created_by,created_at) VALUES('r1','s1',1,'readable','owner',1);
    UPDATE source SET current_revision_id='r1';
    INSERT INTO chat(id,project_id,created_by,created_at,updated_at) VALUES('c1','p1','owner',1,1);
    INSERT INTO chat_turn(chat_id,turn_id,model,scope_mode,scope_json,context_mode,state,created_at)
      VALUES('c1','t1','fixture','explicit','["r1"]','whole','completed',1),('c1','t2','fixture','explicit','["r1"]','whole','completed',2);`);
});

describe('New chat from an unconfirmed first Send', () => {
  type Request = { url: string; body: Record<string, string> };
  async function openDraft(reply: (request: Request) => Promise<Response>) {
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | globalThis.Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') return reply({ url, body: JSON.parse(String(init.body)) as Request['body'] });
      if (url === '/api/models') return json({ models: [], warnings: [] });
      if (url === '/api/projects/p1/chats') return json({ chats: [], nextCursor: null });
      expect(url).toMatch(/^\/api\/projects\/p1\/chats\/[^/]+$/);
      return json({ chat: { id: url.split('/').at(-1) }, turns: [], nextCursor: null, queued: null, stateVersion: 1 });
    }));
    function Subject() {
      const { chatId } = useParams();
      const [question, setQuestion] = useState('First question');
      const [selection, setSelection] = useState<SourceSelection>({ scopeMode: 'explicit', sourceIds: ['s1'] });
      return <ChatView projectId='p1' {...(chatId ? { chatId } : {})} selection={selection} question={question}
        onQuestionChange={setQuestion} onSelectionChange={setSelection}
        onNewChat={() => {}} onSavedPage={() => {}} />;
    }
    router = createMemoryRouter([{ path: '/p/:projectId/chat/:chatId?', element: <Subject /> }], { initialEntries: ['/p/p1/chat'] });
    await act(async () => { root.render(<RouterProvider router={router} />); }); await settle();
  }
  const accepted = (request: Request) => request.url.endsWith('/chats')
    ? json({ chat: { id: request.body.id, title: request.body.title, updatedAt: 1 } }, 201)
    : json({ turnId: request.body.turnId }, 202);
  function question() {
    const field = host.querySelector<HTMLTextAreaElement>('textarea');
    if (!field) throw new Error('Missing question field');
    return field;
  }
  function sendButton() {
    const button = host.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!button) throw new Error('Missing Send button');
    return button;
  }
  async function press(text: string) {
    const button = [...host.querySelectorAll('button')].find(button => button.textContent === text);
    if (!button) throw new Error('Missing action ' + text);
    await act(async () => { button.click(); }); await settle();
  }
  async function typeQuestion(value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!setter) throw new Error('Missing textarea setter');
      setter.call(question(), value);
      question().dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('confirms before clearing an unsent draft on the blank route', async () => {
    const post = vi.fn(async () => { throw new Error('New chat must not write or send'); });
    await openDraft(post);
    vi.mocked(window.confirm).mockReturnValue(false);
    await press('New chat');
    expect(question().value).toBe('First question');
    expect(router.state.location.pathname).toBe('/p/p1/chat');
    vi.mocked(window.confirm).mockReturnValue(true);
    await press('New chat');
    expect(window.confirm).toHaveBeenCalledTimes(2);
    expect(question().value).toBe('');
    expect(router.state.location.pathname).toBe('/p/p1/chat');
    expect(post).not.toHaveBeenCalled();
  });

  it('does not erase a new draft while the New chat route reset is pending', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | globalThis.Request) => {
      const url = String(input);
      if (url === '/api/models') return json({ models: [], warnings: [] });
      if (url === '/api/projects/p1/chats') return json({ chats: [], nextCursor: null });
      return json({ chat: { id: 'c1' }, turns: [], nextCursor: null, queued: null, stateVersion: 1 });
    }));
    function Subject() {
      const { chatId: routeChatId } = useParams();
      const [lastChatId, setLastChatId] = useState<string | undefined>(routeChatId);
      const [question, setQuestion] = useState('Draft to discard');
      const [selection, setSelection] = useState<SourceSelection>({ scopeMode: 'explicit', sourceIds: ['s1'] });
      const chatId = routeChatId ?? lastChatId;
      return <ChatView projectId='p1' {...(chatId ? { chatId } : {})} selection={selection} question={question}
        onQuestionChange={setQuestion} onSelectionChange={setSelection}
        onNewChat={() => {
          setLastChatId(undefined);
          // Model a parent-owned composer update before the passive route-reset effect can settle.
          queueMicrotask(() => setQuestion('Fresh draft entered during the route reset.'));
        }} onSavedPage={() => {}} />;
    }
    router = createMemoryRouter([{ path: '/p/:projectId/chat/:chatId?', element: <Subject /> }], { initialEntries: ['/p/p1/chat/c1'] });
    await act(async () => { root.render(<RouterProvider router={router} />); }); await settle();
    await press('New chat');
    expect(router.state.location.pathname).toBe('/p/p1/chat');
    expect(question().value).toBe('Fresh draft entered during the route reset.');
  });

  it.each(['create', 'turn'])('starts a distinct conversation after a lost %s receipt, while cancelling keeps safe replay', async stage => {
    const requests: Request[] = [];
    const failed: Request[] = [];
    let fail = true;
    await openDraft(async request => {
      requests.push(request);
      if (fail && request.url.endsWith(stage === 'create' ? '/chats' : '/turns')) {
        failed.push(request); throw new TypeError('Accepted reply lost');
      }
      return accepted(request);
    });
    await press('Send');
    expect(host.textContent).toContain('Accepted reply lost');
    vi.mocked(window.confirm).mockReturnValue(false);
    const key = router.state.location.key;
    await press('New chat');
    expect(window.confirm).toHaveBeenCalledWith('Discard your question draft and start a new chat?');
    expect(question().value).toBe('First question');
    expect(router.state.location.key).toBe(key);
    await press('Send');
    expect(failed[1]).toEqual(failed[0]); // Declining New chat must not turn safe replay into another admission.
    vi.mocked(window.confirm).mockReturnValue(true);
    await press('New chat');
    expect(question().value).toBe('');
    expect(host.textContent).not.toContain('Accepted reply lost');
    expect(host.textContent).toContain('Sources: 1 selected');
    const oldCreation = requests.find(request => request.url.endsWith('/chats'));
    if (!oldCreation) throw new Error('Missing old creation');
    fail = false;
    await typeQuestion('First question'); // Even identical text is a new explicit conversation.
    await press('Send');
    const newCreation = requests.filter(request => request.url.endsWith('/chats')).at(-1);
    if (!newCreation) throw new Error('Missing new creation');
    expect(newCreation.body.id).not.toBe(oldCreation.body.id);
    expect(requests.at(-1)?.url).toBe('/api/projects/p1/chats/' + newCreation.body.id + '/turns');
    if (stage === 'turn') expect(requests.at(-1)?.body.turnId).not.toBe(failed[0]?.body.turnId);
    expect(router.state.location.pathname).toBe('/p/p1/chat/' + newCreation.body.id);
  });

  it.each(['create', 'turn'])('releases the composer and ignores a late %s receipt after New chat', async stage => {
    const requests: Request[] = [], held: Array<{ request: Request; resolve: (response: Response) => void }> = [];
    let firstHeld = false;
    await openDraft(async request => {
      requests.push(request);
      if ((!firstHeld && request.url.endsWith(stage === 'create' ? '/chats' : '/turns')) || firstHeld) {
        firstHeld = true;
        return new Promise<Response>(resolve => held.push({ request, resolve }));
      }
      return accepted(request);
    });
    await press('Send');
    expect(held).toHaveLength(1);
    expect(sendButton().disabled).toBe(true);
    await press('New chat');
    expect(question().value).toBe('');
    await typeQuestion('New conversation');
    expect(sendButton().disabled).toBe(false);
    await press('Send');
    expect(held).toHaveLength(2);
    const old = held[0], fresh = held[1];
    if (!old || !fresh) throw new Error('Missing held creations');
    expect(fresh.request.url).toBe('/api/projects/p1/chats');
    expect(fresh.request.body.id).not.toBe(requests[0]?.body.id);
    await act(async () => { old.resolve(accepted(old.request)); }); await settle();
    expect(held).toHaveLength(2); // A late creation reply cannot admit its abandoned question.
    expect(router.state.location.pathname).toBe('/p/p1/chat');
    expect(question().value).toBe('New conversation');
    expect(sendButton().disabled).toBe(true); // Nor can its finally release the newer Send.
    await act(async () => { fresh.resolve(accepted(fresh.request)); }); await settle();
    expect(held).toHaveLength(3);
    const freshTurn = held[2];
    if (!freshTurn) throw new Error('Missing fresh turn');
    expect(freshTurn.request.url).toBe('/api/projects/p1/chats/' + fresh.request.body.id + '/turns');
    await act(async () => { freshTurn.resolve(accepted(freshTurn.request)); }); await settle();
    expect(router.state.location.pathname).toBe('/p/p1/chat/' + fresh.request.body.id);
    expect(question().value).toBe('');
  });
});
afterEach(async () => { await act(async () => root.unmount()); router?.dispose(); host.remove(); db.close(); vi.unstubAllGlobals(); });

it.each(['', 'Retained partial text'])('shows the full failure reason without a redundant empty-answer placeholder: %s', async answer => {
  const reason = 'The selected model could not run. The included allowance could not be verified. Choose an available provider or check its settings; no automatic retry was started.';
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === '/api/models') return json({ models: [], warnings: [] });
    if (url === '/api/projects/p1/chats') return json({ chats: [], nextCursor: null });
    expect(url).toBe('/api/projects/p1/chats/c1');
    return json({ chat: { id: 'c1' }, turns: [{ ...turn('t1'), answer, error: reason, state: answer ? 'partial' : 'failed' }],
      nextCursor: null, queued: null, stateVersion: 1 });
  }));
  router = createMemoryRouter([{ path: '*', element: <ChatView projectId='p1' chatId='c1' selection={{ scopeMode: 'empty', sourceIds: [] }}
    question='' onQuestionChange={() => {}} onSelectionChange={() => {}} onNewChat={() => {}} onSavedPage={() => {}} /> }],
  { initialEntries: ['/p/p1/chat/c1'] });
  await act(async () => { root.render(<RouterProvider router={router} />); }); await settle();
  const item = host.querySelector('[data-turn-id="t1"]');
  expect(item?.querySelector('.er-chat__error')?.textContent).toBe(reason);
  expect(item?.textContent?.split(reason)).toHaveLength(2);
  expect(item?.textContent).not.toContain('No answer available.');
  expect(item?.querySelector('.er-chat__answer')?.textContent ?? '').toBe(answer);
});

function storage(): Env {
  const prepare = (sql: string): Statement => ({ sql, args: [], bind(...args) { return { ...this, args }; },
    async first() { return db.prepare(this.sql).get(...this.args) ?? null; },
    async run() { return db.prepare(this.sql).run(...this.args); } });
  const objects = new Map<string, Uint8Array>();
  return { DB: { prepare, async batch(statements: Statement[]) {
    db.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec('COMMIT'); return results; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } }, BUCKET: {
    async put(key: string, value: string | Uint8Array) { objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value); },
    async get(key: string) { const bytes = objects.get(key); return bytes ? { text: async () => new TextDecoder().decode(bytes), json: async () => JSON.parse(new TextDecoder().decode(bytes)) as unknown } : null; },
    async delete(key: string) { objects.delete(key); },
  }, CHAT: { getByName: () => ({ getStoredTurn: async (_project: string, id: string) => turn(id) }) } } as unknown as Env;
}

it('shows a stored history omission beside an otherwise completed answer', async () => {
  const notice = "Older exchanges were omitted from this answer's context.";
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === '/api/models') return json({ models: [], warnings: [] });
    if (url === '/api/projects/p1/chats') return json({ chats: [], nextCursor: null });
    expect(url).toBe('/api/projects/p1/chats/c1');
    return json({ chat: { id: 'c1' }, turns: [{ ...turn('t1'), historyNotice: notice }], nextCursor: null, queued: null, stateVersion: 1 });
  }));
  router = createMemoryRouter([{ path: '*', element: <ChatView projectId='p1' chatId='c1' selection={{ scopeMode: 'explicit', sourceIds: ['s1'] }}
    question='' onQuestionChange={() => {}} onSelectionChange={() => {}} onNewChat={() => {}} onSavedPage={() => {}} /> }], { initialEntries: ['/p/p1/chat/c1'] });
  await act(async () => { root.render(<RouterProvider router={router} />); }); await settle();
  expect([...host.querySelectorAll('[role="status"]')].map(node => node.textContent)).toContain(notice);
  expect(host.querySelector('[data-turn-id="t1"]')?.getAttribute('data-state')).toBe('completed');
  expect(host.textContent).toContain('Saved evidence');
  expect(host.querySelector('[data-turn-id="t1"] a')?.getAttribute('href')).toBe('/p/p1/source/s1?revisionId=r1&start=0&end=20');
  expect(host.textContent).toContain('Save as page');
});

describe('Save answer retry', () => {
  it.each(['network', 'http', 'json'])('reuses the committed page after a lost %s response, without blocking other saves', async failure => {
    const env = storage();
    const saves: Array<Parameters<typeof saveAnswer>[2]> = [];
    const savedPages: string[] = [];
    const saved = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        expect(url).toBe('/api/projects/p1/pages/from-turn');
        const body = { ...JSON.parse(String(init.body)), projectId: 'p1' } as Parameters<typeof saveAnswer>[2];
        saves.push(body);
        const page = await saveAnswer(env, owner, body); savedPages.push(page.id);
        expect(page.body).toBe(turn(body.turnId).answer); expect(page.citations).toEqual([citation]);
        if (saves.length === 1) {
          if (failure === 'network') throw new TypeError('Connection lost after commit');
          if (failure === 'http') return json({ error: { message: 'Reply unavailable' } }, 503);
          return new Response('truncated', { status: 201 });
        }
        return json({ page }, 201);
      }
      expect(init?.method ?? 'GET').toBe('GET');
      if (url === '/api/models') return json({ models: [], warnings: [] });
      if (url === '/api/projects/p1/chats') return json({ chats: [{ id: 'c1', title: 'Chat', updatedAt: 1 }], nextCursor: null });
      expect(url).toBe('/api/projects/p1/chats/c1');
      return json({ chat: { id: 'c1' }, turns: [turn('t1'), turn('t2')], nextCursor: null, queued: null, stateVersion: 1 });
    }));
    router = createMemoryRouter([{ path: '*', element: <ChatView projectId='p1' chatId='c1' selection={{ scopeMode: 'explicit', sourceIds: ['s1'] }}
      question='' onQuestionChange={() => {}} onSelectionChange={() => {}} onNewChat={() => {}} onSavedPage={saved} /> }], { initialEntries: ['/p/p1/chat/c1'] });
    await act(async () => { root.render(<RouterProvider router={router} />); }); await settle();
    await save('t1');
    expect(saved).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM page').get()?.n).toBe(1);
    await save('t2'); // An independent save must not replace the pending retry identity.
    await save('t1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM page').get()?.n).toBe(2);
    expect(saves[2]?.mutationId).toBe(saves[0]?.mutationId);
    expect(savedPages[2]).toBe(savedPages[0]);
    expect(saved).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('Saved.');
    await save('t1'); // After confirmation, an intentional new copy still works.
    expect(saves[3]?.mutationId).not.toBe(saves[0]?.mutationId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM page').get()?.n).toBe(3);
  });
});

it.each(['before', 'after'])('retains the pending mutation when an old success arrives %s the current failure', async order => {
  const env = storage();
  const saves: Array<Parameters<typeof saveAnswer>[2]> = [];
  const replies: Array<{ resolve: (response: Response) => void; reject: (error: Error) => void; page: unknown }> = [];
  const saved = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      expect(url).toBe('/api/projects/p1/pages/from-turn');
      const body = { ...JSON.parse(String(init.body)), projectId: 'p1' } as Parameters<typeof saveAnswer>[2];
      saves.push(body);
      const page = await saveAnswer(env, owner, body);
      return new Promise<Response>((resolve, reject) => replies.push({ resolve, reject, page }));
    }
    if (url === '/api/models') return json({ models: [], warnings: [] });
    if (url === '/api/projects/p1/chats') return json({ chats: [{ id: 'c1', title: 'Chat', updatedAt: 1 }, { id: 'c2', title: 'Other', updatedAt: 1 }], nextCursor: null });
    expect(init?.method ?? 'GET').toBe('GET');
    expect(url).toMatch(/^\/api\/projects\/p1\/chats\/c[12]$/);
    return json({ chat: { id: url.endsWith('c2') ? 'c2' : 'c1' }, turns: [turn('t1')], nextCursor: null, queued: null, stateVersion: 1 });
  }));
  function Subject() {
    const { chatId } = useParams();
    return <ChatView projectId='p1' {...(chatId ? { chatId } : {})} selection={{ scopeMode: 'explicit', sourceIds: ['s1'] }} question='' onQuestionChange={() => {}} onSelectionChange={() => {}} onNewChat={() => {}} onSavedPage={saved} />;
  }
  router = createMemoryRouter([{ path: '/p/:projectId/chat/:chatId', element: <Subject /> }], { initialEntries: ['/p/p1/chat/c1'] });
  await act(async () => { root.render(<RouterProvider router={router} />); }); await settle();
  await save('t1'); // The first response is still in flight, but its write committed.
  await act(async () => { await router.navigate('/p/p1/chat/c2'); }); await settle();
  await act(async () => { await router.navigate('/p/p1/chat/c1'); }); await settle();
  await save('t1');
  expect(saves[1]?.mutationId).toBe(saves[0]?.mutationId);
  const oldSuccess = async () => { await act(async () => replies[0]?.resolve(json({ page: replies[0]?.page }, 201))); await settle(); };
  if (order === 'before') await oldSuccess();
  await act(async () => replies[1]?.reject(new TypeError('Current reply lost'))); await settle();
  if (order === 'after') await oldSuccess();
  expect(host.textContent).not.toContain('Saved.'); // The success belongs to the abandoned visit.
  expect(host.textContent).toContain('Current reply lost');
  await save('t1');
  await act(async () => replies[2]?.resolve(json({ page: replies[2]?.page }, 201))); await settle();
  expect(saves[2]?.mutationId).toBe(saves[0]?.mutationId);
  expect(db.prepare('SELECT COUNT(*) AS n FROM page').get()?.n).toBe(1);
  expect(host.textContent).toContain('Saved.');
  await save('t1');
  expect(saves[3]?.mutationId).not.toBe(saves[0]?.mutationId);
  await act(async () => replies[3]?.resolve(json({ page: replies[3]?.page }, 201))); await settle();
  expect(db.prepare('SELECT COUNT(*) AS n FROM page').get()?.n).toBe(2);
});


describe('Chat snapshot source selection', () => {
  let historyReply: { resolve(response: Response): void; reject(error: Error): void };
  const historyReads: Array<typeof historyReply & { signal: AbortSignal | null | undefined }> = [];
  const sockets: Array<{ onmessage?: (event: { data: string }) => void }> = [];
  let chooseScope: (scope: SourceSelection) => void;
  let changeQuestion: (question: string) => void;
  let deferReceipt: boolean, receiptReply: (response: Response) => void;
  let currentScope: SourceSelection;
  let posts: Array<{ scopeMode: string; sourceIds?: string[]; turnId: string }>;
  let stored: TurnView;
  const snapshot = () => ({ turns: [stored], nextCursor: null, queued: null, stateVersion: 3 });
  async function receiveSnapshot() {
    await act(async () => { sockets.at(-1)?.onmessage?.({ data: JSON.stringify({ type: 'snapshot', ...snapshot() }) }); });
  }
  async function failHistory() {
    await act(async () => { historyReply.reject(new TypeError('Transient GET failure')); }); await settle();
  }
  async function resolveHistory() {
    await act(async () => { historyReply.resolve(json({ chat: { id: router.state.location.pathname.split('/').at(-1) }, ...snapshot() })); }); await settle();
  }
  async function submit() {
    const form = host.querySelector<HTMLFormElement>('form');
    if (!form) throw new Error('Missing chat composer');
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await settle();
  }
  function Subject() {
    const [selection, setSelection] = useState<SourceSelection>({ scopeMode: 'project_default', sourceIds: [] });
    const [question, setQuestion] = useState('Follow up');
    currentScope = selection; chooseScope = setSelection; changeQuestion = setQuestion;
    const { chatId } = useParams();
    return <ChatView projectId='p1' {...(chatId ? { chatId } : {})} selection={selection} question={question}
      onQuestionChange={setQuestion} onSelectionChange={setSelection} onNewChat={() => {}} onSavedPage={() => {}} />;
  }
  beforeEach(async () => {
    vi.stubGlobal('WebSocket', class { constructor() { sockets.push(this); } close() {} onmessage?: (event: { data: string }) => void; });
    stored = { ...turn('t1'), createdAt: 1, historyVersion: 2 }; posts = []; sockets.length = 0; historyReads.length = 0; deferReceipt = false;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/models') return json({ models: [], warnings: [] });
      if (url === '/api/projects/p1/chats' && init?.method === 'POST') {
        const creation = JSON.parse(String(init.body)) as { id: string; title: string };
        return json({ chat: { ...creation, updatedAt: 1 } });
      }
      if (url === '/api/projects/p1/chats') return json({ chats: [{ id: 'c1', title: 'Existing conversation', updatedAt: 1 }], nextCursor: null });
      if (/^\/api\/projects\/p1\/chats\/[^/]+\/turns$/.test(url) && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as typeof posts[number]; posts.push(body);
        if (deferReceipt) return new Promise<Response>(resolve => { receiptReply = resolve; });
        return json({ turnId: body.turnId });
      }
      expect(url).toMatch(/^\/api\/projects\/p1\/chats\/[^/]+$/);
      return new Promise<Response>((resolve, reject) => {
        historyReply = { resolve, reject }; historyReads.push({ ...historyReply, signal: init?.signal });
      });
    }));
    router = createMemoryRouter([{ path: '/p/:projectId/chat/:chatId?', element: <Subject /> }], { initialEntries: ['/p/p1/chat/c1'] });
    await act(async () => { root.render(<StrictMode><RouterProvider router={router} /></StrictMode>); }); await settle();
  });
  it('ignores a retired StrictMode socket and restores from its replacement', async () => {
    expect(sockets).toHaveLength(2);
    await act(async () => { sockets[0]?.onmessage?.({ data: JSON.stringify({ type: 'snapshot', ...snapshot() }) }); });
    expect(host.textContent).not.toContain('Saved evidence');
    expect(host.textContent).toContain('Loading this conversation');
    await receiveSnapshot();
    expect(host.textContent).toContain('Saved evidence');
    expect(currentScope).toEqual({ scopeMode: 'explicit', sourceIds: ['s1'] });
    await submit();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.sourceIds).toEqual(['s1']);
  });
  it('retries the active history read after StrictMode aborts the first request', async () => {
    expect(historyReads).toHaveLength(2);
    expect(historyReads[0]?.signal?.aborted).toBe(true);
    expect(historyReads[1]?.signal?.aborted).toBe(false);
    // The browser fixture must fail every pending GET, not just the aborted first one.
    await act(async () => {
      for (const read of historyReads) read.resolve(json({ error: { message: 'Initial history unavailable' } }, 503));
    }); await settle();
    const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry');
    expect(host.textContent).toContain('Initial history unavailable');
    if (!retry) throw new Error('Missing history Retry');
    await act(async () => { retry.click(); }); await settle();
    expect(historyReads).toHaveLength(3);
    expect(historyReads[2]?.signal?.aborted).toBe(false);
    expect(posts).toHaveLength(0);
    await receiveSnapshot(); await resolveHistory(); await submit();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.sourceIds).toEqual(['s1']);
  });
  it.each(['explicit', 'empty'] as const)('restores %s scope before Send when the socket precedes HTTP', async scopeMode => {
    stored = { ...stored, scopeMode, sourceIds: scopeMode === 'explicit' ? ['s1'] : [],
      revisionIds: scopeMode === 'explicit' ? ['r1'] : [], citations: scopeMode === 'explicit' ? [citation] : [],
      answer: scopeMode === 'explicit' ? stored.answer : 'Saved evidence-free answer' };
    await receiveSnapshot();
    expect(host.textContent).toContain('Saved evidence');
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
    await submit();
    await resolveHistory();
    expect(currentScope).toEqual({ scopeMode, sourceIds: stored.sourceIds });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.scopeMode).toBe(scopeMode);
    expect(posts[0]?.sourceIds).toEqual(scopeMode === 'explicit' ? ['s1'] : undefined);
  });
  it.each(['GET fails first', 'socket first'])('restores source scope when %s and the other transport fails', async order => {
    if (order === 'GET fails first') await failHistory();
    await receiveSnapshot();
    if (order === 'socket first') await failHistory();
    await submit();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.scopeMode).toBe('explicit');
    expect(posts[0]?.sourceIds).toEqual(['s1']);
  });
  it('keeps HTTP-first restoration and later reconnects consistent', async () => {
    await resolveHistory(); await receiveSnapshot(); await submit();
    expect(posts[0]?.scopeMode).toBe('explicit'); expect(posts[0]?.sourceIds).toEqual(['s1']);
  });
  it('does not restore a later reconnect scope after initial hydration', async () => {
    await receiveSnapshot(); await resolveHistory();
    stored = { ...stored, turnId: 't2', createdAt: 2, sourceIds: ['s2'] };
    await receiveSnapshot(); await submit();
    expect(currentScope).toEqual({ scopeMode: 'explicit', sourceIds: ['s1'] });
    expect(posts[0]?.sourceIds).toEqual(['s1']);
  });
  it('restores from the merged latest live turn rather than an older head', async () => {
    const newer = { ...stored, turnId: 't2', createdAt: 2, sourceIds: ['s2'] };
    await act(async () => { sockets.at(-1)?.onmessage?.({ data: JSON.stringify({ type: 'turn', turn: newer }) }); });
    await receiveSnapshot(); await submit();
    expect(currentScope).toEqual({ scopeMode: 'explicit', sourceIds: ['s2'] });
    expect(posts[0]?.sourceIds).toEqual(['s2']);
  });
  it.each(['before hydration', 'after socket'])('preserves a manual selection made %s across both transports and reconnect', async timing => {
    if (timing === 'after socket') await receiveSnapshot();
    await act(async () => { chooseScope({ scopeMode: 'explicit', sourceIds: ['s2'] }); });
    await receiveSnapshot(); await resolveHistory(); await receiveSnapshot(); await submit();
    expect(currentScope).toEqual({ scopeMode: 'explicit', sourceIds: ['s2'] });
    expect(posts[0]?.sourceIds).toEqual(['s2']);
  });
  it.each(['HTTP first', 'socket first'].flatMap(order => ['unchanged', 'empty', 'explicit empty'].map(choice => ({ order, choice }))))('keeps $choice scope through history Retry with $order', async ({ order, choice }) => {
      await failHistory();
      if (choice !== 'unchanged') await act(async () => { chooseScope({ scopeMode: choice === 'empty' ? 'empty' : 'explicit', sourceIds: [] }); });
      const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry');
      if (!retry) throw new Error('Missing history Retry');
      await act(async () => { retry.click(); }); await settle();
      expect(posts).toHaveLength(0);
      if (order === 'HTTP first') { await resolveHistory(); await receiveSnapshot(); }
      else { await receiveSnapshot(); await resolveHistory(); }
      await submit();
      const scopeMode = choice === 'empty' ? 'empty' : 'explicit';
      expect(currentScope).toEqual({ scopeMode, sourceIds: choice === 'unchanged' ? ['s1'] : [] });
      expect(posts).toHaveLength(1);
      expect(posts[0]?.scopeMode).toBe(scopeMode);
      expect(posts[0]?.sourceIds).toEqual(choice === 'empty' ? undefined : choice === 'unchanged' ? ['s1'] : []);
    });
  it('keeps a manual empty scope when retrying a later settlement notice', async () => {
    await receiveSnapshot(); await resolveHistory();
    await act(async () => { chooseScope({ scopeMode: 'empty', sourceIds: [] }); });
    await act(async () => { sockets.at(-1)?.onmessage?.({ data: JSON.stringify({ type: 'queued', stateVersion: 4,
      queued: null, settlementError: 'Usage save needs retry' }) }); });
    const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry');
    if (!retry) throw new Error('Missing settlement Retry');
    await act(async () => { retry.click(); }); await settle();
    await receiveSnapshot(); await resolveHistory(); await submit();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.scopeMode).toBe('empty'); expect(posts[0]?.sourceIds).toBeUndefined();
  });
  it('keeps a newly selected scope when the first Send navigates to its new chat', async () => {
    await act(async () => { await router.navigate('/p/p1/chat'); }); await settle();
    await act(async () => { chooseScope({ scopeMode: 'explicit', sourceIds: ['s1'] }); changeQuestion('First question'); });
    deferReceipt = true;
    await submit();
    expect(posts[0]?.sourceIds).toEqual(['s1']);
    await act(async () => { chooseScope({ scopeMode: 'explicit', sourceIds: ['s2'] }); });
    await act(async () => { receiptReply(json({ turnId: posts[0]?.turnId })); }); await settle();
    expect(router.state.location.pathname).toMatch(/\/chat\/[^/]+$/);
    await receiveSnapshot(); await resolveHistory();
    expect(currentScope).toEqual({ scopeMode: 'explicit', sourceIds: ['s2'] });
  });
});

// Regression for the live audit: saved chats opened at their oldest loaded turn.
// These controlled scroll metrics test lifecycle ordering, not browser geometry.
describe('Saved chat reading position', () => {
  let container: HTMLDivElement, top: number, height: number, visible: boolean;
  let resize: (entries: Array<{ contentRect: { width: number; height: number } }>) => void;
  let reply: (response: Response) => void;
  let message: (event: { data: string }) => void;
  const snapshot = () => ({ turns: [1, 2, 3].map(id => ({ ...turn('t' + id), createdAt: id, historyVersion: 1 })),
    nextCursor: null, queued: null, stateVersion: 1 });
  const http = async () => { await act(async () => reply(json({ chat: { id: 'c1' }, ...snapshot() }))); await settle(); };
  const socketHead = async () => { await act(async () => message({ data: JSON.stringify({ type: 'snapshot', ...snapshot() }) })); };
  const scroll = async (value: number) => { await act(async () => {
    container.scrollTop = value; container.dispatchEvent(new Event('scroll'));
  }); };
  const show = async (value: boolean) => { await act(async () => {
    visible = value; resize([{ contentRect: { width: value ? 800 : 0, height: value ? 200 : 0 } }]);
  }); };
  const latest = () => host.querySelector<HTMLButtonElement>('[aria-label="Jump to latest message"]');
  beforeEach(async () => {
    visible = true; top = 0; height = 1200;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: typeof resize) { resize = callback; }
      observe() { resize([{ contentRect: { width: 800, height: 200 } }]); }
      disconnect() {}
    });
    vi.stubGlobal('WebSocket', class {
      set onmessage(callback: typeof message) { message = callback; }
      close() {}
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method ?? 'GET').toBe('GET');
      const url = String(input);
      if (url === '/api/models') return json({ models: [], warnings: [] });
      if (url === '/api/projects/p1/chats') return json({ chats: [], nextCursor: null });
      return new Promise<Response>(resolve => { reply = resolve; });
    }));
    function Subject() {
      const { '*': path } = useParams();
      const chatId = path?.startsWith('chat/') ? path.slice('chat/'.length) : 'c1';
      const [selection, setSelection] = useState<SourceSelection>({ scopeMode: 'project_default', sourceIds: [] });
      return <ChatView projectId='p1' chatId={chatId} selection={selection} question=''
        onQuestionChange={() => {}} onSelectionChange={setSelection} onNewChat={() => {}} onSavedPage={() => {}} />;
    }
    router = createMemoryRouter([{ path: '/p/:projectId/*', element: <Subject /> }], { initialEntries: ['/p/p1/chat/c1'] });
    await act(async () => { root.render(<RouterProvider router={router} />); }); await settle();
    const conversation = host.querySelector<HTMLDivElement>('.er-chat__conversation');
    if (!conversation) throw new Error('Missing conversation');
    container = conversation;
    Object.defineProperties(container, {
      clientHeight: { get: () => visible ? 200 : 0 }, scrollHeight: { get: () => height },
      scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height - 200)); } },
    });
  });
  it.each(['HTTP first', 'socket first'])('opens latest once when %s, without late head/reconnect jumps', async order => {
    if (order === 'HTTP first') await http(); else await socketHead();
    expect(top).toBe(1000); expect(latest()).toBeNull();
    await scroll(325);
    expect(latest()).not.toBeNull();
    if (order === 'HTTP first') await socketHead(); else await http();
    await socketHead();
    expect(top).toBe(325);
  });
  it('waits for a hidden chat to become visible, then preserves Reader/Back position', async () => {
    await show(false); await http();
    expect(top).toBe(0);
    await show(true);
    expect(top).toBe(1000);
    await scroll(325);
    await act(async () => { await router.navigate('/p/p1/source/s1'); });
    await show(false); await socketHead();
    await act(async () => { await router.navigate(-1); });
    await show(true);
    expect(top).toBe(325); expect(latest()).not.toBeNull();
  });
  it('starts another chat at its latest turn instead of carrying over the previous reading position', async () => {
    await http(); await scroll(325);
    await act(async () => { await router.navigate('/p/p1/chat/c2'); }); await settle();
    await socketHead();
    expect(top).toBe(1000); expect(latest()).toBeNull();
  });
  it('does not pull a reader down for streamed growth; Latest restores the end and focus', async () => {
    await http(); await scroll(325); height = 1800;
    await act(async () => message({ data: JSON.stringify({ type: 'turn',
      turn: { ...turn('t3'), createdAt: 3, historyVersion: 2, answer: 'Updated answer' } }) }));
    expect(top).toBe(325);
    await act(async () => { latest()?.click(); });
    expect(top).toBe(1600);
    expect(document.activeElement).toBe(host.querySelector('[data-turn-id="t3"]'));
    expect(latest()).toBeNull();
  });
  it('keeps the first-open jump pending after a failed read, but does not repeat it on later Retry', async () => {
    await act(async () => reply(json({ error: { message: 'History unavailable' } }, 503))); await settle();
    expect(top).toBe(0);
    const retry = () => {
      const button = [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry');
      if (!button) throw new Error('Missing Retry');
      return button;
    };
    await act(async () => retry().click()); await settle(); await http();
    expect(top).toBe(1000); await scroll(325);
    await act(async () => message({ data: JSON.stringify({ type: 'queued', stateVersion: 2,
      queued: null, settlementError: 'Status read unavailable' }) }));
    await act(async () => retry().click()); await settle(); await http();
    expect(top).toBe(325);
  });
});
