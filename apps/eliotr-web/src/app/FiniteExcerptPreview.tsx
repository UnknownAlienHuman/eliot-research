import { paneAnnouncement, announcementUntil } from './announcementAssertions';
import { useEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type RefObject } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { ArtifactRevision, VerifiedEvidence } from '@eliotr/owner-api-client';
import { Shell } from './Shell';
import { ReportPanel } from './ReportPanel';
import { createWorkspaceRuntime } from './runtime';
import { createPrivacyController, type SessionContext } from './privacy';
import { clearWorkspaceQueries, createWorkspaceQueryClient, protectedQueryKey } from '../query/client';
import { reportQueryOptions } from '../query/reports';

const stamp = '2026-10-09T12:00:00.000Z', generation = 'research-fixture';
const artifactRef = { id: 'report-fixture', revision: 1 }, sectionRef = { id: 'section-1', revision: 1 };
const scopeRef = { id: 'scope-fixture', revision: 1 }, handleRef = { id: 'handle-fixture', revision: 1 };
const excerpt = 'The saved question keeps its original source scope.';
const sectionText = '## Saved draft\n\nA saved draft keeps the question and its evidence together.\n';
const encode = (value: string) => new TextEncoder().encode(value);
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))].map(value => value.toString(16).padStart(2, '0')).join('');
function gate() {
  let complete: () => void = () => {};
  const promise = new Promise<void>(resolve => { complete = resolve; });
  return { promise, release: () => complete() };
}
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
type OutletProps = ComponentProps<NonNullable<ComponentProps<typeof Shell>['fixtureOutlet']>>;

function createFixture(view: RefObject<HTMLDivElement | null>) {
  const client = createWorkspaceQueryClient(), timers = { setTimeout: () => 0, clearTimeout() {} };
  const held = gate(), started = gate(), delivered = gate();
  let verifications = 0, opened = 0, lateReturned = 0, armed = false;
  let heldSignal: AbortSignal | null | undefined, pendingRead: Promise<void> | undefined;
  const excerptHash = digest(encode(excerpt));
  const readyManifest: Promise<ArtifactRevision> = digest(encode(sectionText)).then(hash => ({
    artifact_ref: artifactRef, spec_ref: { id: 'spec-fixture', revision: 1 }, spec_digest: 'a'.repeat(64),
    evidence_freeze_ref: { id: 'freeze-fixture', revision: 1 }, sections: [{ section_ref: sectionRef, contract_id: 'contract-1',
      body_object_ref: 'body-1', body_sha256: hash, statement_labels: {}, evidence_ledger_ref: 'ledger-fixture', verification_receipt_ref: 'verification-section' }],
    dependency_manifest_ref: 'dependencies-fixture', deterministic_export_refs: {}, status: 'DRAFT', created_at: stamp,
  }));
  const json = (data: unknown) => new Response(JSON.stringify({ data, trace_id: 'research-trace', deployment_generation: generation }), { headers: { 'content-type': 'application/json' } });
  const prefix = '/api/v1/research/artifact/report-fixture%3A1', sectionPath = prefix + '/sections/section-1%3A1';
  const fetchFixture: typeof fetch = async (input, init) => {
    const url = new URL(String(input), 'https://fixture.invalid'), method = init?.method ?? 'GET';
    assert(url.origin === 'https://fixture.invalid' && !url.search && !url.hash, 'Fixture request escaped its exact synthetic origin');
    if (method === 'GET' && url.pathname === '/api/v1/system/health') return json({ ready: true, deployment_generation: generation, core_schema_generation: 'schema-1', search_schema_generation: 'schema-1', blocking_reason_codes: [], checked_at: stamp });
    if (method === 'GET' && url.pathname === '/api/v1/system/session') return json({ protocol: 'eliotr.owner-session.v1', principal_ref: 'research-owner', credential_generation: 'research-credential', client_class: 'owner_pwa', expires_at: '2027-01-01T00:00:00.000Z' });
    if (method === 'GET' && url.pathname === prefix) return json(await readyManifest);
    if (method === 'GET' && url.pathname === sectionPath) {
      const artifact = await readyManifest, section = artifact.sections[0]; assert(section, 'Declared section missing');
      const bytes = encode(sectionText);
      return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength),
        'x-eliotr-artifact-ref': encodeURIComponent('report-fixture:1'), 'x-eliotr-section-ref': encodeURIComponent('section-1:1'),
        'x-eliotr-section-object-ref': encodeURIComponent(section.body_object_ref), 'x-eliotr-section-sha256': section.body_sha256, 'x-eliotr-deployment-generation': generation } });
    }
    if (method === 'GET' && url.pathname === sectionPath + '/citations') return json({ protocol: 'eliotr.artifact-section-citations.v1', artifact_ref: artifactRef,
      section_ref: sectionRef, scope_snapshot_ref: scopeRef, verification_receipt_ref: 'verification-section', semantic_verification: 'NOT_EXECUTED', cited_evidence: [{ handle_ref: handleRef, excerpt_sha256: await excerptHash }] });
    if (method === 'POST' && url.pathname === '/api/v1/research/verify') {
      const body: unknown = JSON.parse(String(init?.body));
      assert(body !== null && typeof body === 'object' && 'scope_snapshot_ref' in body && 'handle_ref' in body && Object.keys(body).length === 2 &&
        JSON.stringify(body.scope_snapshot_ref) === JSON.stringify(scopeRef) && JSON.stringify(body.handle_ref) === JSON.stringify(handleRef), 'Verification changed the saved scope or selected handle');
      assert(new Headers(init?.headers).get('x-eliotr-csrf') === '1', 'Verification lost the accepted transport header');
      verifications++; assert(verifications <= 2, 'Unexpected repeated verification');
      const handle = { handle_ref: handleRef, source_namespace_id: 'namespace-fixture', source_owner_generation: 'source-owner-fixture', source_revision_ref: 'source-revision-fixture', scope_snapshot_ref: scopeRef,
        anchor: { kind: 'normalized_byte_range', start: 0, end: encode(excerpt).byteLength }, excerpt_sha256: await excerptHash, excerpt_byte_length: encode(excerpt).byteLength,
        object_residency_key_digest: 'b'.repeat(64), source_assurance_ceiling: 'EXACT', materializer_assurance_ceiling: 'EXACT', terminal_state: 'LIVE', created_at: stamp };
      return json({ handle, resolved_evidence: { handle, exact_excerpt: excerpt, verification_receipt_ref: 'evidence-verification', authorization_receipt_ref: 'evidence-authorization', credential_generation: 'research-credential',
        source_revision_content_sha256: 'c'.repeat(64), scope_snapshot_digest: 'd'.repeat(64), instruction_taint: 'UNTRUSTED', allowed_effects: 'READ_ONLY', resolved_at: stamp } });
    }
    if (method === 'GET' && url.pathname === '/api/v1/research/open/handle-fixture%3A1') {
      opened++; assert(opened <= 2 && verifications === opened, 'Open escaped explicit verification');
      const hash = await excerptHash;
      if (opened === 2) {
        assert(armed, 'An unarmed second excerpt request was dispatched');
        heldSignal = init?.signal; started.release();
        // Hostile transport deliberately ignores abort; the accepted client owns refusal/discard.
        await held.promise; lateReturned++; delivered.release();
      }
      return new Response(excerpt, { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(encode(excerpt).byteLength),
        'x-eliotr-evidence-handle': 'handle-fixture:1', 'x-eliotr-excerpt-sha256': hash, 'x-eliotr-verification-receipt': 'evidence-verification' } });
    }
    throw new Error('Unexpected finite excerpt request: ' + method + ' ' + url.pathname);
  };
  const runtime = createWorkspaceRuntime({ fetch: fetchFixture, baseUrl: 'https://fixture.invalid', timers, now: () => Date.parse(stamp), sha256: digest,
    mint() { throw new Error('This excerpt case has no new intent'); }, isCurrent: context => privacy.isCurrent(context), onAuthorizationLoss() { privacy.close(); } });
  const privacy = createPrivacyController({ timers, now: () => Date.parse(stamp),
    mask() { if (view.current) { view.current.hidden = true; view.current.inert = true; } runtime.close(); },
    reveal() { if (view.current) { view.current.hidden = false; view.current.inert = false; } },
    cancelReads() { void client.cancelQueries(undefined, { revert: false, silent: true }); }, clearProtected() { clearWorkspaceQueries(client); }, verify: signal => runtime.verify(signal) });
  function Outlet({ locale, destination, headingRef }: OutletProps) {
    const snapshot = useSyncExternalStore(privacy.subscribe, privacy.getSnapshot, privacy.getSnapshot);
    const [open, setOpen] = useState(true);
    if (snapshot.phase !== 'available') return null;
    const apis = runtime.read(snapshot.context); if (!apis) return null;
    return <div className="er-live-workspace"><aside className="er-shell-sources" hidden={destination !== 'research'}><h2>Synthetic source scope</h2><p>Currentness unknown; semantic assessment not executed.</p></aside>
      <main className="er-shell-reading" id="workspace-main"><h1 id="workspace-heading" ref={headingRef} tabIndex={-1}>Research</h1>
        {destination === 'research' && open && <ReportPanel apis={apis} privacy={privacy} context={snapshot.context} locale={locale} artifactRef={artifactRef}
          onClose={() => setOpen(false)} onOpenDraft={() => { throw new Error('No draft mutation in the excerpt fixture'); }} />}
      </main></div>;
  }
  return { client, runtime, privacy, Outlet, held,
    metrics: () => ({ verifications, opened, lateReturned, heldAborted: heldSignal?.aborted === true }),
    async holdRead() {
      const snapshot = privacy.getSnapshot(); assert(snapshot.phase === 'available', 'Current context missing');
      const context = snapshot.context, apis = runtime.read(context); assert(apis, 'Current runtime missing');
      const queryKey = reportQueryOptions(apis, privacy, context, () => undefined).evidence(scopeRef, { handle_ref: handleRef, excerpt_sha256: await excerptHash }).queryKey;
      assert(privacy.isCurrent(context), 'Context changed before explicit refetch');
      const first = client.getQueryData<VerifiedEvidence>(queryKey);
      assert(first?.text === excerpt && opened === 1 && verifications === 1, 'First verified excerpt was not present in actual Query');
      assert(!armed, 'This finite read is already armed'); armed = true;
      pendingRead = client.refetchQueries({ queryKey, exact: true, type: 'active' }, { cancelRefetch: false });
      await Promise.race([started.promise, pendingRead.then(() => { throw new Error('Refetch settled before the second response was held'); })]);
      return { context, queryKey };
    },
    async finishLateRead() { assert(pendingRead, 'Held Query refetch missing'); await Promise.all([delivered.promise, pendingRead]); },
  };
}
type Environment = ReturnType<typeof createFixture>;
const environments = new WeakMap<HTMLElement, Environment>();

/** Private candidate: relocate to apps/eliotr-web/src/app before registration. */
export function FiniteExcerptPreview() {
  const view = useRef<HTMLDivElement>(null), [environment] = useState(() => createFixture(view));
  useEffect(() => {
    const node = view.current; if (node) environments.set(node, environment);
    const unsubscribe = environment.privacy.subscribe(() => { const snapshot = environment.privacy.getSnapshot(); if (snapshot.phase === 'available') environment.runtime.bind(snapshot.context); });
    void environment.privacy.refresh();
    return () => { if (node) environments.delete(node); unsubscribe(); environment.privacy.dispose(); environment.runtime.dispose(); clearWorkspaceQueries(environment.client); environment.held.release(); };
  }, [environment]);
  return <div data-finite-excerpt ref={view} hidden inert><QueryClientProvider client={environment.client}><MemoryRouter initialEntries={['/research']}>
    <Shell privacy={environment.privacy} runtime={environment.runtime} fixture={true} fixtureOutlet={environment.Outlet} />
  </MemoryRouter></QueryClientProvider></div>;
}
interface ExcerptPlayContext {
  readonly canvasElement: HTMLElement;
  readonly canvas: {
    findByRole(role: string, options: { readonly name: string; readonly exact?: boolean }): Promise<HTMLElement>;
    findByText(text: string | RegExp): Promise<HTMLElement>;
    queryByText(text: string): HTMLElement | null;
  };
  readonly userEvent: { click(element: HTMLElement): Promise<void> };
}
const frame = () => new Promise<void>(resolve => { requestAnimationFrame(() => resolve()); });
function oldCacheCount(environment: Environment, context: SessionContext) {
  const prefix = protectedQueryKey(context, 'reports').slice(0, -1);
  return environment.client.getQueryCache().getAll().filter(query => prefix.every((value, index) => query.queryKey[index] === value)).length;
}
export async function playFiniteExcerptLifecycle(test: ExcerptPlayContext) {
  const host = test.canvasElement.querySelector<HTMLElement>('[data-finite-excerpt]'), environment = host && environments.get(host);
  assert(environment && host, 'Finite excerpt fixture was not registered');
  await test.userEvent.click(await test.canvas.findByRole('button', { name: 'Read · Section 1', exact: true }));
  const reportRoot = test.canvasElement.querySelector<HTMLElement>('.er-live-report');
  assert(reportRoot, 'Actual report root absent');
  const reportRegion = reportRoot.querySelector<HTMLElement>(':scope > .er-operation-announcement');
  assert(reportRegion && reportRegion.getAttribute('aria-live') === 'polite' && reportRegion.getAttribute('aria-atomic') === 'true', 'Report operation channel absent');
  await test.userEvent.click(await test.canvas.findByRole('button', { name: 'Open cited excerpt 1', exact: true }));
  await test.canvas.findByText(excerpt);
  await announcementUntil(() => reportRegion.isConnected && reportRegion.textContent === 'The selected cited excerpt was verified.');
  const rail = reportRoot.querySelector<HTMLElement>('.evidence');
  assert(rail && rail.querySelectorAll('[role="status"], [role="alert"], [aria-live]').length === 0, 'Static citation rows created live regions');
  const actionRoot = reportRoot.querySelector<HTMLElement>('section[aria-label="Review and acceptance"]');
  assert(actionRoot && paneAnnouncement(actionRoot).textContent === '', 'Cached artifact facts announced while reading evidence');
  assert(!test.canvas.queryByText('Supported'), 'Resolution was promoted into semantic support');
  const original = await environment.holdRead();
  try {
    environment.privacy.close();
    assert(!environment.privacy.isCurrent(original.context), 'The original context remained current');
    assert(host.hidden && host.inert, 'Actual privacy mask did not synchronously close visibility');
    assert(oldCacheCount(environment, original.context) === 0, 'Invalidation retained old protected Query entries');
    await frame();
    assert(!test.canvasElement.textContent?.includes(excerpt), 'Open excerpt remained in the invalidated Shell');
    assert(!reportRegion.isConnected && test.canvasElement.querySelectorAll('[role="status"], [role="alert"], [aria-live]').length === 0, 'Privacy loss retained an operation channel');
    environment.held.release(); await environment.finishLateRead(); await frame();
    const metrics = environment.metrics();
    assert(metrics.opened === 2 && metrics.verifications === 2 && metrics.lateReturned === 1 && metrics.heldAborted, 'The exact held response did not return after accepted transport cancellation');
    assert(!test.canvasElement.textContent?.includes(excerpt), 'Late response restored old excerpt text');
    assert(test.canvasElement.querySelectorAll('[role="status"], [role="alert"], [aria-live]').length === 0, 'Late protected response recreated a channel');
    assert(environment.client.getQueryData(original.queryKey) === undefined && oldCacheCount(environment, original.context) === 0, 'Late response restored an old protected cache entry');
    assert(!test.canvas.queryByText('Supported'), 'Late resolution became semantic support');
  } finally { environment.held.release(); }
}
