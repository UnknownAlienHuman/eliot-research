// Saved-history reading through the actual local workspace, with controlled stored snapshots.
// No model request is made. Native source ingestion and Reader reads retain exact identities.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect, type WebSocketRoute } from '@playwright/test';
import { assertEvalBrowserOrigin, fetchEval } from './origin.mjs';

assert(process.env.ELIOT_K2_MODEL !== '1', 'Scroll acceptance forbids model calls.');
const origin = assertEvalBrowserOrigin(process.env.ELIOT_URL || 'http://127.0.0.1:5173', process.env.ELIOT_ORIGIN);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname));
const api = async (path, body?) => {
  const response = await fetchEval(origin + path, { headers: { Origin: origin, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }, origin, process.env.ELIOT_ORIGIN);
  const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data;
};
const project = (await api('/api/projects', { title: 'Saved chat reading ' + crypto.randomUUID() })).project.id;
const chat = (await api(`/api/projects/${project}/chats`, { title: 'Saved conversation' })).chat.id;
const created = await api(`/api/projects/${project}/sources/text`, { title: 'Reading evidence', text: '# Evidence\n\nRetained source ' + crypto.randomUUID() });
let source;
await expect.poll(async () => { source = (await api('/api/sources/' + created.sourceId)).source; return source.readableState; }).toBe('readable');
assert.equal(source.conversionCalls, 0);
const citation = { sourceId: source.id, revisionId: source.currentRevisionId, sourceTitle: source.title,
  block: 1, start: 0, end: 10, label: '[R' + source.currentRevisionId + ':1]', deleted: false };
const makeTurn = i => ({ turnId: 'scroll-' + i, createdAt: i, historyVersion: 1, question: 'Question ' + i,
  answer: 'Saved answer ' + i + ' ' + citation.label + '\n\n' + ('Evidence remains readable without another model call.\n\n').repeat(5),
  state: 'completed', model: 'fixture', scopeMode: 'explicit', sourceIds: [source.id], revisionIds: [source.currentRevisionId], citations: [citation],
  invalidLabels: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, tokenLimit: 0, firstTokenMs: null, totalMs: 0, error: null });
const path = `/p/${project}/chat/${chat}`, historyUrl = origin + `/api/projects/${project}/chats/${chat}`;
const browser = await chromium.launch();
await mkdir('eval/out/k2', { recursive: true });
try {
  for (const viewport of [{ width: 1212, height: 799 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage(), sockets = new Set<WebSocketRoute>(), writes: string[] = [];
    // Preserve actual layout transitions on failure; a single final offset cannot
    // distinguish font reflow from a viewport resized by asynchronous controls.
    await page.addInitScript(() => {
      const measurements: unknown[] = [];
      Object.assign(window, { chatScrollMeasurements: measurements });
      let previous = '', observed: Element | null = null;
      const sample = (reason: string) => {
        const box = document.querySelector('.er-chat__conversation');
        if (!box) return;
        const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().height;
        const geometry = { top: box.scrollTop, height: box.clientHeight, total: box.scrollHeight,
          turns: rect('.er-chat__turns'), composer: rect('.er-chat__composer'), header: rect('.er-chat__head'),
          projectHeader: rect('.er-project-workspace__header'), latest: !!document.querySelector('.er-chat__latest'),
          fonts: document.fonts.status };
        const next = JSON.stringify(geometry);
        if (next === previous) return;
        previous = next;
        measurements.push({ reason, ...geometry });
        if (measurements.length > 80) measurements.shift();
      };
      const sizes = new ResizeObserver(() => sample('resize'));
      new MutationObserver(() => {
        const box = document.querySelector('.er-chat__conversation');
        if (box && box !== observed) {
          observed = box;
          for (const selector of ['.er-chat__conversation', '.er-chat__turns', '.er-chat__composer']) {
            const element = document.querySelector(selector); if (element) sizes.observe(element);
          }
          box.addEventListener('scroll', () => sample('scroll'));
        }
        sample('DOM');
      }).observe(document, { childList: true, subtree: true });
      document.fonts.addEventListener('loadingdone', () => sample('fonts ready'));
    });
    let turns = Array.from({ length: 8 }, (_, i) => makeTurn(i + 3));
    const head = () => ({ chat: { id: chat }, turns, nextCursor: 'earlier', queued: null, stateVersion: 1 });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort());
    await page.route('**/api/**', route => {
      if (route.request().method() === 'GET') return route.fallback();
      writes.push(route.request().url()); return route.abort('blockedbyclient');
    });
    const gate = () => {
      let release: () => void = () => {};
      const waiting = new Promise<void>(resolve => { release = resolve; });
      return { waiting, release };
    };
    let modelsGate = gate();
    const fontsGate = gate();
    await page.route(origin + '/api/models', async route => { await modelsGate.waiting; return route.fallback(); });
    await page.route('**/fonts/*.woff2', async route => { await fontsGate.waiting; return route.fallback(); });
    await page.route(historyUrl, route => route.fulfill({ json: head() }));
    await page.route(historyUrl + '/turns?cursor=*', route => route.fulfill({ json: { turns: [makeTurn(1), makeTurn(2)], nextCursor: null } }));
    await page.routeWebSocket(url => url.pathname === '/agents/chat-agent/' + chat, socket => {
      sockets.add(socket); socket.onClose(() => { sockets.delete(socket); });
      socket.send(JSON.stringify({ type: 'snapshot', ...head() }));
    });
    try {
      const conversation = page.locator('.er-chat__conversation'), latest = page.getByRole('button', { name: 'Jump to latest message' });
      const position = () => conversation.evaluate(el => ({ top: el.scrollTop, remaining: el.scrollHeight - el.clientHeight - el.scrollTop }));
      await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
      await expect(conversation).toContainText('Saved answer 10');
      await expect(conversation.locator('[data-turn-id]')).toHaveCount(8);
      await expect.poll(async () => (await position()).remaining).toBeLessThanOrEqual(1);
      fontsGate.release(); await page.evaluate(() => document.fonts.ready);
      await expect.poll(async () => (await position()).remaining).toBeLessThanOrEqual(1);
      modelsGate.release();
      await expect(page.getByText('Loading model catalog…', { exact: true })).toHaveCount(0);
      await expect.poll(async () => (await position()).remaining).toBeLessThanOrEqual(1);
      await expect(latest).toHaveCount(0);
      await page.screenshot({ path: `eval/out/k2/chat-latest-${viewport.width}.png` });
      // Keep a deliberate reading position through immutable Reader navigation and Back.
      const reading = conversation.locator('[data-turn-id="scroll-5"]');
      await reading.evaluate(el => { const box = el.closest('.er-chat__conversation'); box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top; });
      await expect(latest).toBeVisible();
      const before = (await position()).top;
      await reading.locator('a[href*="/source/"]').first().click();
      await expect(page.locator('.er-lib__text')).toContainText('Retained source');
      await page.getByRole('link', { name: 'Back to chat', exact: true }).click();
      await expect.poll(async () => Math.abs((await position()).top - before)).toBeLessThanOrEqual(1);
      // Late/reconnected heads and content below the reader must not reset that position.
      turns = [...turns.slice(0, -1), { ...turns.at(-1), historyVersion: 2, answer: turns.at(-1).answer + '\n\nMore retained output.' }];
      for (const socket of sockets) socket.send(JSON.stringify({ type: 'snapshot', ...head() }));
      await expect(conversation).toContainText('More retained output.');
      assert(Math.abs((await position()).top - before) <= 1);
      await page.screenshot({ path: `eval/out/k2/chat-history-${viewport.width}.png` });
      await latest.focus(); await latest.press('Enter');
      await expect.poll(async () => (await position()).remaining).toBeLessThanOrEqual(1);
      await expect(conversation.locator('[data-turn-id="scroll-10"]')).toBeFocused();
      // Earlier-page insertion retains the same visible turn's position.
      await conversation.evaluate(el => { el.scrollTop = 0; });
      const first = conversation.locator('[data-turn-id="scroll-3"]');
      const offset = () => first.evaluate(el => el.getBoundingClientRect().top - el.closest('.er-chat__conversation').getBoundingClientRect().top);
      const anchor = await offset();
      await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
      await expect(conversation.locator('[data-turn-id]')).toHaveCount(10);
      assert(Math.abs(await offset() - anchor) <= 1);
      // A user who begins reading before catalogue notices settle must not be
      // pulled back to the bottom by the same resize that keeps initial entry aligned.
      modelsGate = gate();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(conversation).toContainText('Saved answer 10');
      await page.evaluate(() => document.fonts.ready);
      await expect.poll(async () => (await position()).remaining).toBeLessThanOrEqual(1);
      await reading.evaluate(el => { const box = el.closest('.er-chat__conversation'); box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top; });
      await expect(latest).toBeVisible();
      const beforeCatalog = (await position()).top;
      modelsGate.release();
      await expect(page.getByText('Loading model catalog…', { exact: true })).toHaveCount(0);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert(Math.abs((await position()).top - beforeCatalog) <= 1);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(writes, []);
      console.log(JSON.stringify({ scope: 'K2_CHAT_SCROLL_BROWSER', viewport, storedSnapshotFixture: true, newModelCalls: 0,
        initialLatest: true, readerBack: true, lateHead: true, explicitLatest: true, olderAnchor: true, reloadLatest: true, delayedFontAndCatalog: true, readingDuringCatalog: true }));
    } catch (error) {
      console.log(JSON.stringify({ scope: 'K2_CHAT_SCROLL_FAILURE', viewport,
        measurements: await page.evaluate(() => Reflect.get(window, 'chatScrollMeasurements')) }));
      await page.screenshot({ path: `eval/out/k2/chat-scroll-failed-${viewport.width}.png` });
      throw error;
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
