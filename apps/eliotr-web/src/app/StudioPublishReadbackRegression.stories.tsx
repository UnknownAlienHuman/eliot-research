import { useEffect, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { WikiProposalReadView } from '@eliotr/owner-api-client';
import { Shell } from './Shell';
import { createWorkspaceRuntime } from './runtime';
import { createPrivacyController } from './privacy';
import { clearWorkspaceQueries, createWorkspaceQueryClient } from '../query/client';

const stamp = '2026-10-13T12:00:00.000Z';
const staleReadbackCheckedAt = '2026-10-13T11:59:59.000Z';
const generation = 'studio-publish-readback-regression';
const readbackId = 'wiki-proposal-readback';
const staleId = 'wiki-proposal-stale';
const decoderId = 'wiki-proposal-decoder';
const readbackTitle = 'Readback recovery keeps publication confirmed';
const staleTitle = 'Stale proposal read cannot undo publication';
const decoderTitle = 'Malformed receipt remains unknown';
const readbackBody = 'The canonical receipt remains true when a later Wiki read fails.';
const staleBody = 'A valid stale draft read follows a canonical publication receipt.';
const decoderBody = 'A malformed receipt cannot be treated as a confirmed publication.';
const encode = (value: string) => new TextEncoder().encode(value);
const digest = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))]
    .map(value => value.toString(16).padStart(2, '0')).join('');

interface PublicationAttempt {
  readonly body: string;
  readonly key: string;
  readonly proposalId: string;
  readonly expectedHead: number;
}
interface RequestEvent { readonly method: string; readonly path: string }
interface ReadbackEnvironment {
  readonly client: ReturnType<typeof createWorkspaceQueryClient>;
  readonly privacy: ReturnType<typeof createPrivacyController>;
  readonly runtime: ReturnType<typeof createWorkspaceRuntime>;
  readonly stopBinding: () => void;
  readbackProposalReads(): number;
  staleProposalReads(): number;
  isStaleReadValidated(): boolean;
  requestEventCount(): number;
  requestEventsSince(index: number): readonly RequestEvent[];
  assertReadbackFailure(): void;
  assertReadbackRetry(): void;
  assertStaleSuccess(): void;
  assertDecoderUnknown(): void;
  assertDecoderRetry(): void;
}
const studioEnvironments = new WeakMap<HTMLElement, ReadbackEnvironment>();

function StudioPublishReadbackPreview() {
  const [environment] = useState<ReadbackEnvironment>(() => {
    const client = createWorkspaceQueryClient();
    const timers = { setTimeout: () => 0, clearTimeout() {} };
    const requestEvents: RequestEvent[] = [];
    const proposalReads = new Map<string, number>();
    const publicationAttempts: PublicationAttempt[] = [];
    let allPosts = 0;
    let proposalCreatePosts = 0;
    let mintedKeys = 0;
    let readbackPublished = false;
    let staleReceiptAccepted = false;
    let staleReadbacksAfterReceipt = 0;
    let decoderPublished = false;
    let failedSecondaryRead = false;
    let secondaryFailureDelivered = false;

    const proposalInfo = (id: string) => id === readbackId
      ? { pageId: 'wiki-page-readback', title: readbackTitle, body: readbackBody }
      : id === decoderId
        ? { pageId: 'wiki-page-decoder', title: decoderTitle, body: decoderBody }
        : id === staleId
          ? { pageId: 'wiki-page-stale', title: staleTitle, body: staleBody }
          : undefined;
    const isPublished = (id: string) => id === readbackId ? readbackPublished : id === decoderId ? decoderPublished : false;
    const json = (data: unknown) => new Response(JSON.stringify({
      data, trace_id: 'studio-publish-readback-trace', deployment_generation: generation,
    }), { headers: { 'content-type': 'application/json' } });
    const unavailable = () => new Response(JSON.stringify({
      error: { code: 'WIKI_READ_TEMPORARILY_UNAVAILABLE', message: 'Controlled secondary Wiki read failure', retryable: true },
      trace_id: 'studio-publish-readback-trace', deployment_generation: generation,
    }), { status: 503, headers: { 'content-type': 'application/json' } });

    const page = async (proposalId: string): Promise<WikiProposalReadView['page']> => {
      const info = proposalInfo(proposalId);
      if (!info) throw new Error('Unexpected Wiki proposal identity: ' + proposalId);
      return {
        page_ref: { id: info.pageId, revision: 2 },
        page_type: 'Topic',
        title: info.title,
        scope_snapshot_ref: { id: 'wiki-scope-' + proposalId, revision: 1 },
        body_object_ref: 'wiki-body-' + proposalId,
        body_sha256: await digest(encode(info.body)),
        statement_labels: {},
        evidence_map_ref: 'wiki-map-' + proposalId,
        counterposition_refs: [],
        coverage_receipt_ref: { id: 'wiki-coverage-' + proposalId, revision: 1 },
        limitations: [],
        dependency_refs: [],
        generator_generation: 'wiki-generator-readback-regression',
        status: isPublished(proposalId) ? 'PUBLISHED' : 'DRAFT',
        supersedes_ref: { id: info.pageId, revision: 1 },
        publication_metadata: {},
        created_at: stamp,
      };
    };
    const summary = (id: string) => {
      const info = proposalInfo(id);
      if (!info) throw new Error('Unexpected Wiki proposal summary: ' + id);
      return {
        proposal_ref: { id, revision: 1 },
        page_ref: { id: info.pageId, revision: 2 },
        title: info.title,
        page_type: 'Topic',
        risk_class: 'D2_ANALYTICAL',
        state: isPublished(id) ? 'PUBLISHED' : 'PROPOSED',
        created_at: stamp,
      };
    };
    const readProposal = async (id: string) => {
      const info = proposalInfo(id);
      if (!info) throw new Error('Unexpected Wiki proposal read: ' + id);
      const count = (proposalReads.get(id) ?? 0) + 1;
      proposalReads.set(id, count);
      if (id === readbackId && readbackPublished && !secondaryFailureDelivered) {
        secondaryFailureDelivered = true;
        failedSecondaryRead = true;
        return unavailable();
      }
      if (id === staleId && staleReceiptAccepted) staleReadbacksAfterReceipt++;
      const loadedPage = await page(id);
      return json({
        protocol: 'eliotr.wiki-proposal-read.v2',
        proposal_ref: { id, revision: 1 },
        page: loadedPage,
        risk_class: 'D2_ANALYTICAL',
        state: isPublished(id) ? 'PUBLISHED' : 'PROPOSED',
        source_freshness: {
          state: 'PREVIOUS_REVISIONS',
          checked_at: id === staleId && staleReceiptAccepted ? staleReadbackCheckedAt : stamp,
          changed_sources: [{
            source_id: 'wiki-source-readback-regression',
            saved_revision_ref: 'source-old',
            head_revision_ref: 'source-new',
          }],
        },
      });
    };
    const readBody = async (id: string) => {
      const info = proposalInfo(id);
      if (!info) throw new Error('Unexpected Wiki proposal body read: ' + id);
      const loadedPage = await page(id);
      return new Response(info.body, { headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': String(encode(info.body).byteLength),
        'x-eliotr-wiki-proposal-ref': encodeURIComponent(id + ':1'),
        'x-eliotr-wiki-page-ref': encodeURIComponent(info.pageId + ':2'),
        'x-eliotr-body-sha256': loadedPage.body_sha256,
        'x-eliotr-deployment-generation': generation,
      } });
    };

    const fetchFixture: typeof fetch = async (input, init) => {
      const url = new URL(String(input), 'https://fixture.invalid');
      const method = (init?.method ?? 'GET').toUpperCase();
      requestEvents.push({ method, path: url.pathname });
      if (method === 'POST') {
        allPosts++;
        if (url.pathname === '/api/v1/research/wiki/proposals/from-edit') {
          proposalCreatePosts++;
          throw new Error('Regression flow unexpectedly attempted to create a proposal');
        }
        if (url.pathname !== '/api/v1/research/wiki/publications') {
          throw new Error('Unexpected Studio POST: ' + url.pathname);
        }
        const body = String(init?.body ?? '');
        const request = JSON.parse(body) as {
          readonly proposal_ref?: { readonly id?: unknown; readonly revision?: unknown };
          readonly expected_head_revision?: unknown;
        };
        const id = request.proposal_ref?.id;
        const info = typeof id === 'string' ? proposalInfo(id) : undefined;
        const key = new Headers(init?.headers).get('idempotency-key');
        if (!info || request.proposal_ref?.revision !== 1 || request.expected_head_revision !== 1 ||
          !key || new Headers(init?.headers).get('x-eliotr-csrf') !== '1') {
          throw new Error('Strict publication request lost its proposal, CAS, or idempotency identity');
        }
        publicationAttempts.push({
          body, key, proposalId: id as string, expectedHead: request.expected_head_revision as number,
        });
        if (id === readbackId) {
          if (publicationAttempts.filter(attempt => attempt.proposalId === readbackId).length !== 1) {
            throw new Error('Readback recovery dispatched publication more than once');
          }
          readbackPublished = true;
          return json({
            protocol: 'eliotr.wiki-publication.v1',
            page_ref: { id: info.pageId, revision: 2 },
            status: 'PUBLISHED',
            reviewer_ref: 'studio-owner',
          });
        }
        if (id === staleId) {
          const staleAttempts = publicationAttempts.filter(attempt => attempt.proposalId === staleId);
          if (staleAttempts.length !== 1) throw new Error('Unexpected repeated stale-case publication');
          staleReceiptAccepted = true;
          return json({
            protocol: 'eliotr.wiki-publication.v1',
            page_ref: { id: info.pageId, revision: 2 },
            status: 'PUBLISHED',
            reviewer_ref: 'studio-owner',
          });
        }
        const decoderAttempts = publicationAttempts.filter(attempt => attempt.proposalId === decoderId);
        if (decoderAttempts.length === 1) {
          return json({
            protocol: 'eliotr.wiki-publication.v1',
            page_ref: { id: 'wrong-wiki-page', revision: 2 },
            status: 'PUBLISHED',
            reviewer_ref: 'studio-owner',
          });
        }
        if (decoderAttempts.length === 2) {
          decoderPublished = true;
          return json({
            protocol: 'eliotr.wiki-publication.v1',
            page_ref: { id: info.pageId, revision: 2 },
            status: 'PUBLISHED',
            reviewer_ref: 'studio-owner',
          });
        }
        throw new Error('Unexpected repeated decoder-case publication');
      }

      if (url.pathname === '/api/v1/system/health') return json({
        ready: true, deployment_generation: generation, core_schema_generation: 'schema-1',
        search_schema_generation: 'schema-1', blocking_reason_codes: [], checked_at: stamp,
      });
      if (url.pathname === '/api/v1/system/session') return json({
        protocol: 'eliotr.owner-session.v1', principal_ref: 'studio-owner',
        credential_generation: 'studio-credential', client_class: 'owner_pwa',
        expires_at: '2027-01-01T00:00:00.000Z',
      });
      if (url.pathname === '/api/v1/research/projects') return json({
        protocol: 'eliotr.project-owner-list.v1', projects: [],
      });
      if (url.pathname === '/api/v1/research/runs') return json({
        protocol: 'eliotr.research-runs.v3', runs: [], saved_drafts: [],
        configuration_state: 'INSTALLED', checked_at: stamp,
      });
      if (url.pathname === '/api/v1/system/research-configuration') return json({
        protocol: 'eliotr.research-configuration-readiness.v1', configuration: 'present',
        model_transport: 'available', qualification_state: 'current', run_readiness: 'ready',
        readiness_reason: 'QUALIFICATION_PROOFS_CURRENT', model_route: 'research-route',
        qualification_expires_at: '2027-01-01T00:00:00.000Z', missing_fields: [],
        invalid_fields: [], checked_at: stamp,
      });
      if (url.pathname === '/api/v1/research/wiki/proposals') return json({
        protocol: 'eliotr.wiki-proposals.v1',
        items: [summary(readbackId), summary(staleId), summary(decoderId)],
        has_more: false, next_cursor: null,
      });
      const proposalMatch = /^\/api\/v1\/research\/wiki\/proposals\/(wiki-proposal-readback|wiki-proposal-stale|wiki-proposal-decoder)(\/body)?$/u.exec(url.pathname);
      if (proposalMatch) {
        const proposalId = proposalMatch[1];
        if (!proposalId) throw new Error('Missing Wiki proposal id');
        if (proposalMatch[2]) return readBody(proposalId);
        return readProposal(proposalId);
      }
      throw new Error('Unexpected Studio fixture request: ' + url.pathname);
    };

    const runtime = createWorkspaceRuntime({
      fetch: fetchFixture,
      baseUrl: 'https://fixture.invalid',
      timers,
      now: () => Date.parse(stamp),
      sha256: digest,
      mint() {
        mintedKeys++;
        return '00000000-0000-4000-8000-' + String(mintedKeys).padStart(12, '0');
      },
      isCurrent: context => privacy.isCurrent(context),
      onAuthorizationLoss() { privacy.close(); },
    });
    const privacy = createPrivacyController({
      timers,
      now: () => Date.parse(stamp),
      mask() { runtime.close(); },
      reveal() {},
      cancelReads() { void client.cancelQueries(undefined, { revert: false, silent: true }); },
      clearProtected() { clearWorkspaceQueries(client); },
      verify: signal => runtime.verify(signal),
    });
    const stopBinding = privacy.subscribe(() => {
      const snapshot = privacy.getSnapshot();
      if (snapshot.phase === 'available') runtime.bind(snapshot.context);
    });

    const isStaleReadValidated = () => client.getQueryCache().getAll().some(query => {
      const data = query.state.data as WikiProposalReadView | undefined;
      return data?.proposal_ref?.id === staleId && data.proposal_ref.revision === 1 &&
        data.page?.page_ref?.id === 'wiki-page-stale' && data.page.page_ref.revision === 2 &&
        data.state === 'PROPOSED' && data.page.status === 'DRAFT' &&
        data.source_freshness.checked_at === staleReadbackCheckedAt;
    });
    // Hoisted so the assertion helpers below can read it. These helpers are returned as properties
    // of the same object literal, so calling this as a property would look itself up before it is
    // initialized, and a plain inner reference would not resolve at all.
    const staleProposalReadCount = () => proposalReads.get(staleId) ?? 0;

    return {
      client, runtime, privacy, stopBinding,
      readbackProposalReads: () => proposalReads.get(readbackId) ?? 0,
      staleProposalReads: staleProposalReadCount,
      isStaleReadValidated,
      requestEventCount: () => requestEvents.length,
      requestEventsSince(index: number) { return requestEvents.slice(index); },
      assertReadbackFailure() {
        if (!failedSecondaryRead || !readbackPublished ||
          publicationAttempts.filter(attempt => attempt.proposalId === readbackId).length !== 1) {
          throw new Error('Canonical PUBLISHED receipt did not survive the controlled secondary GET failure');
        }
      },
      assertReadbackRetry() {
        const readbackAttempts = publicationAttempts.filter(attempt => attempt.proposalId === readbackId);
        if (!failedSecondaryRead || readbackAttempts.length !== 1 || mintedKeys !== 1 ||
          allPosts !== 1 || proposalCreatePosts !== 0 || !readbackPublished) {
          throw new Error('Read retry dispatched a mutation, minted a new key, or created a proposal');
        }
      },
      assertStaleSuccess() {
        const staleAttempts = publicationAttempts.filter(attempt => attempt.proposalId === staleId);
        const readbackAttempts = publicationAttempts.filter(attempt => attempt.proposalId === readbackId);
        if (!staleReceiptAccepted || staleProposalReadCount() < 2 || staleReadbacksAfterReceipt < 1 || !isStaleReadValidated() ||
          staleAttempts.length !== 1 || readbackAttempts.length !== 1 ||
          staleAttempts[0]?.key === readbackAttempts[0]?.key || staleAttempts[0]?.expectedHead !== 1 ||
          mintedKeys !== 2 || allPosts !== 2 || proposalCreatePosts !== 0) {
          throw new Error('A valid stale PROPOSED/DRAFT read undid the canonical receipt or created a new publish identity');
        }
      },
      assertDecoderUnknown() {
        const decoderAttempts = publicationAttempts.filter(attempt => attempt.proposalId === decoderId);
        if (decoderAttempts.length !== 1 || mintedKeys !== 3 || allPosts !== 3 ||
          proposalCreatePosts !== 0 || decoderPublished) {
          throw new Error('Malformed canonical receipt did not remain an unconfirmed original intent');
        }
      },
      assertDecoderRetry() {
        const decoderAttempts = publicationAttempts.filter(attempt => attempt.proposalId === decoderId);
        if (decoderAttempts.length !== 2 || decoderAttempts[0]?.key !== decoderAttempts[1]?.key ||
          decoderAttempts[0]?.body !== decoderAttempts[1]?.body ||
          decoderAttempts[0]?.expectedHead !== decoderAttempts[1]?.expectedHead ||
          mintedKeys !== 3 || allPosts !== 4 || proposalCreatePosts !== 0 || !decoderPublished) {
          throw new Error('Decoder recovery changed the original POST identity or created a proposal');
        }
      },
    };
  });

  useEffect(() => {
    void environment.privacy.refresh();
    return () => {
      environment.stopBinding();
      environment.privacy.dispose();
      environment.runtime.dispose();
      environment.client.clear();
    };
  }, [environment]);

  return (
    <div data-studio-publish-readback-regression="" ref={node => {
      if (node) studioEnvironments.set(node, environment);
    }}>
      <QueryClientProvider client={environment.client}>
        <MemoryRouter initialEntries={['/studio']}>
          <Shell privacy={environment.privacy} runtime={environment.runtime} fixture={false} />
        </MemoryRouter>
      </QueryClientProvider>
    </div>
  );
}

async function playStudioPublishReadbackRegression({ canvas, userEvent }: {
  readonly canvas: {
    findByRole(role: string, options: { readonly name: string | RegExp; readonly exact?: boolean }): Promise<HTMLElement>;
    getByRole(role: string, options: { readonly name: string; readonly exact?: boolean }): HTMLElement;
    findByText(text: string, options?: { readonly selector?: string }): Promise<HTMLElement>;
    queryByRole(role: string, options: { readonly name: string; readonly exact?: boolean }): HTMLElement | null;
  };
  readonly userEvent: { click(element: HTMLElement): Promise<void> };
}) {
  let firstChoice: HTMLElement;
  try {
    firstChoice = await canvas.findByRole('button', { name: new RegExp(readbackTitle) });
  } catch (error) {
    const root = document.querySelector<HTMLElement>('[data-studio-publish-readback-regression]');
    const environment = root ? studioEnvironments.get(root) : undefined;
    const failedQueries = environment?.client.getQueryCache().getAll()
      .filter(query => query.state.error !== null)
      .map(query => String(query.state.error));
    const snapshot = environment?.privacy.getSnapshot();
    const binding = snapshot?.phase === 'available' && environment
      ? { current: environment.privacy.isCurrent(snapshot.context), bound: environment.runtime.read(snapshot.context) !== undefined }
      : { phase: snapshot?.phase };
    throw new Error('Studio fixture did not load its proposal: ' + JSON.stringify({ failedQueries, binding,
      queryStates: environment?.client.getQueryCache().getAll().map(query => ({ key: query.queryKey, status: query.state.status, fetchStatus: query.state.fetchStatus })),
      rendered: root?.querySelector('.er-studio-live')?.textContent,
      requests: environment?.requestEventsSince(0) }), { cause: error });
  }
  const root = firstChoice.closest<HTMLElement>('[data-studio-publish-readback-regression]');
  if (!root) throw new Error('Composed Studio regression root is missing');
  const environment = studioEnvironments.get(root);
  if (!environment) throw new Error('Composed Query/runtime/owner-client probe is missing');

  await userEvent.click(firstChoice);
  await canvas.findByText(readbackBody, { selector: '.er-studio-live__body' });
  await userEvent.click(await canvas.findByRole('button', { name: 'Publish page', exact: true }));
  await userEvent.click(await canvas.findByRole('button', { name: 'Confirm publication', exact: true }));
  await canvas.findByText(
    'Publication is confirmed, but reading the published page failed. Retry the read; it will not publish again.',
    { selector: '.er-status > span' },
  );
  await canvas.findByText('Publication confirmed for this Wiki page.', { selector: '.er-status > span' });
  environment.assertReadbackFailure();

  const readsBeforeRetry = environment.readbackProposalReads();
  const requestsBeforeRetry = environment.requestEventCount();
  await userEvent.click(await canvas.findByRole('button', { name: 'Retry reading the published page', exact: true }));
  await canvas.findByText('Published', { selector: 'dd' });
  const retryEvents = environment.requestEventsSince(requestsBeforeRetry);
  if (environment.readbackProposalReads() !== readsBeforeRetry + 1 ||
    retryEvents.length === 0 || retryEvents.some(event => event.method !== 'GET')) {
    throw new Error('Published-page recovery did not issue GET-only readback');
  }
  environment.assertReadbackRetry();

  const staleChoice = await canvas.findByRole('button', { name: new RegExp(staleTitle) });
  if (staleChoice.matches(':disabled')) throw new Error('Confirmed publication readback left proposal selection blocked');
  await userEvent.click(staleChoice);
  await canvas.findByText(staleBody, { selector: '.er-studio-live__body' });
  await userEvent.click(await canvas.findByRole('button', { name: 'Publish page', exact: true }));
  await userEvent.click(await canvas.findByRole('button', { name: 'Confirm publication', exact: true }));
  await canvas.findByText('Publication confirmed for this Wiki page.', { selector: '.er-status > span' });
  for (let frame = 0; frame < 120 &&
    (!environment.isStaleReadValidated() || environment.client.isFetching() !== 0); frame++) {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
  if (!environment.isStaleReadValidated() || environment.client.isFetching() !== 0) {
    throw new Error('Stale publication read did not settle');
  }
  for (const action of [
    canvas.queryByRole('button', { name: 'Publish page', exact: true }),
    canvas.queryByRole('button', { name: 'Confirm publication', exact: true }),
  ]) {
    if (action && !action.matches(':disabled')) {
      throw new Error('A stale PROPOSED/DRAFT read enabled another publication action');
    }
  }
  environment.assertStaleSuccess();

  await userEvent.click(await canvas.findByRole('button', { name: new RegExp(decoderTitle) }));
  await canvas.findByText(decoderBody, { selector: '.er-studio-live__body' });
  await userEvent.click(await canvas.findByRole('button', { name: 'Publish page', exact: true }));
  await userEvent.click(await canvas.findByRole('button', { name: 'Confirm publication', exact: true }));
  await canvas.findByText(
    'The last action has no confirmed outcome. Its original draft, content and request identity are preserved.',
    { selector: '.er-status > span' },
  );
  await canvas.findByRole('button', { name: 'Check the same action', exact: true });
  environment.assertDecoderUnknown();

  await userEvent.click(canvas.getByRole('button', { name: 'Check the same action', exact: true }));
  await canvas.findByText('Publication confirmed for this Wiki page.', { selector: '.er-status > span' });
  await canvas.findByText('Published', { selector: 'dd' });
  environment.assertDecoderRetry();
  if (canvas.queryByRole('button', { name: 'Publish page', exact: true }) ||
    canvas.queryByRole('button', { name: 'Confirm publication', exact: true })) {
    throw new Error('Confirmed publication exposed a new publish action');
  }
}

export default {
  title: 'Workspace/Studio publish readback regression',
  component: StudioPublishReadbackPreview,
  parameters: { layout: 'fullscreen' },
};

export const StudioPublishReadbackRegression = {
  name: 'Studio Publish Readback Regression',
  render: () => <StudioPublishReadbackPreview />,
  play: playStudioPublishReadbackRegression,
};
