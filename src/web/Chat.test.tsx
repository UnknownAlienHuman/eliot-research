// @vitest-environment jsdom
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveAnswer } from '../pages';
import type { TurnView } from '../shared/api';
import { ChatView } from './Chat';

vi.mock('./ModelPicker', () => ({ ModelPicker: () => null }));
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
  db = new DatabaseSync(':memory:');
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
afterEach(async () => { await act(async () => root.unmount()); router?.dispose(); host.remove(); db.close(); vi.unstubAllGlobals(); });

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
