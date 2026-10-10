import { useEffect, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { Shell } from './Shell';
import { createWorkspaceRuntime } from './runtime';
import { createPrivacyController } from './privacy';
import { clearWorkspaceQueries, createWorkspaceQueryClient } from '../query/client';

const stamp = '2026-10-09T12:00:00.000Z';
const generation = 'bundle-fixture';
const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice())), value => value.toString(16).padStart(2, '0')).join('');

/** Real bundle client and binary transport, with only the local HTTP boundary replaced. */
export function BundlePreview() {
  const [environment] = useState(() => {
    const client = createWorkspaceQueryClient();
    const timers = { setTimeout: () => 0, clearTimeout() {} };
    let mintCount = 0, prepareCount = 0, commitCount = 0;
    let manifestDigest = '', totalBytes = 0;
    const hashes = new Map<string, string>(), parts = new Map<string, Uint8Array>(), completed = new Set<string>();
    const json = (data: unknown) => new Response(JSON.stringify({ data, trace_id: 'bundle-trace', deployment_generation: generation }), { headers: { 'content-type': 'application/json' } });
    const receipt = () => ({ operation_id: 'bundle-operation', manifest_sha256: manifestDigest, source_revision_ref: 'bundle-revision', normalized_artifact_ref: 'bundle-artifact', object_residency_key_digest: 'c'.repeat(64), decision: 'ADMITTED', reason_codes: [], readback_sha256: 'd'.repeat(64), committed_at: stamp });
    const fetchFixture: typeof fetch = async (input, init) => {
      const url = new URL(String(input), 'https://fixture.invalid');
      if (url.pathname === '/api/v1/system/health') return json({ ready: true, deployment_generation: generation, core_schema_generation: 'schema-1', search_schema_generation: 'schema-1', blocking_reason_codes: [], checked_at: stamp });
      if (url.pathname === '/api/v1/system/session') return json({ protocol: 'eliotr.owner-session.v1', principal_ref: 'bundle-owner', credential_generation: 'bundle-credential', client_class: 'owner_pwa', expires_at: '2027-01-01T00:00:00.000Z' });
      if (url.pathname === '/api/v1/research/projects') return json({ protocol: 'eliotr.project-owner-list.v1', projects: [] });
      if (url.pathname === '/api/v1/library/namespaces') return json({ protocol: 'eliotr.owner-namespaces.v1', profiles: [], namespaces: [] });
      const headers = new Headers(init?.headers);
      if (init?.method === 'POST' || init?.method === 'PUT') {
        if (headers.get('x-eliotr-csrf') !== '1') throw new Error('Bundle mutation lost CSRF binding');
      }
      if (url.pathname === '/api/v1/ingest/bundles/prepare') {
        prepareCount++;
        if (prepareCount !== 1 || mintCount !== 1 || init?.method !== 'POST') throw new Error('Bundle preparation repeated');
        const body: unknown = JSON.parse(String(init.body));
        if (!body || typeof body !== 'object' || !('file_hashes' in body) || !body.file_hashes || typeof body.file_hashes !== 'object' || !('idempotency_key' in body) || body.idempotency_key !== '11111111-1111-4111-8111-111111111111' || !('total_bytes' in body) || typeof body.total_bytes !== 'number') throw new Error('Bundle preparation lost its frozen request');
        for (const [path, hash] of Object.entries(body.file_hashes)) { if (typeof hash !== 'string') throw new Error('Invalid hash'); hashes.set(path, hash); }
        manifestDigest = hashes.get('manifest.json') ?? ''; totalBytes = body.total_bytes;
        return json({ operation_id: 'bundle-operation', manifest_sha256: manifestDigest, disposition: 'UPLOAD_REQUIRED', expires_at: '2026-10-09T13:00:00.000Z', reason_codes: [], multipart_session_ref: 'bundle-session', files: [...hashes].map(([path, expected_sha256]) => ({ path, expected_sha256, max_part_bytes: 6291456 })) });
      }
      if (url.pathname === '/api/v1/ingest/bundles/bundle-operation/parts/1') {
        const path = url.searchParams.get('path');
        const bytes: unknown = init?.body;
        if (!path) throw new Error('Invalid part path');
        if (!(bytes instanceof Uint8Array)) throw new Error('Invalid part bytes');
        const partBytes = bytes.slice();
        if (parts.has(path) || url.searchParams.get('multipart_session_ref') !== 'bundle-session' || headers.get('content-type') !== 'application/octet-stream' || await digest(partBytes) !== hashes.get(path)) throw new Error('Part bytes, hash or upload identity changed');
        parts.set(path, partBytes);
        return json({ operation_id: 'bundle-operation', multipart_session_ref: 'bundle-session', path, part_number: 1, size_bytes: partBytes.byteLength, etag: 'part-etag' });
      }
      if (url.pathname === '/api/v1/ingest/bundles/bundle-operation/files/complete') {
        const body: unknown = JSON.parse(String(init?.body));
        if (!body || typeof body !== 'object' || !('path' in body) || typeof body.path !== 'string' || !parts.has(body.path) || completed.has(body.path) || !('multipart_session_ref' in body) || body.multipart_session_ref !== 'bundle-session') throw new Error('File completion repeated or lost identity');
        const bytes = parts.get(body.path); if (!bytes) throw new Error('Missing part'); completed.add(body.path);
        return json({ operation_id: 'bundle-operation', multipart_session_ref: 'bundle-session', path: body.path, sha256: hashes.get(body.path), size_bytes: bytes.byteLength, etag: 'file-etag', completed_at: stamp });
      }
      if (url.pathname === '/api/v1/ingest/bundles/commit') {
        commitCount++;
        const body: unknown = JSON.parse(String(init?.body));
        if (commitCount !== 1 || completed.size !== 3 || [...parts.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0) !== totalBytes || !body || typeof body !== 'object' || !('operation_id' in body) || body.operation_id !== 'bundle-operation' || !('manifest_sha256' in body) || body.manifest_sha256 !== manifestDigest) throw new Error('Commit repeated or frozen bytes changed');
        throw new TypeError('Synthetic lost commit acknowledgement after the durable commit');
      }
      if (url.pathname === '/api/v1/ingest/bundles/bundle-operation' && init?.method === 'GET') {
        if (commitCount !== 1 || prepareCount !== 1 || mintCount !== 1) throw new Error('Readback replaced the bundle operation');
        return json({ operation_id: 'bundle-operation', source_revision_ref: 'bundle-revision', state: 'COMMITTED', expires_at: '2026-10-09T13:00:00.000Z', updated_at: stamp, receipt: receipt() });
      }
      throw new Error('Unexpected bundle fixture request: ' + url.pathname);
    };
    const runtime = createWorkspaceRuntime({ fetch: fetchFixture, baseUrl: 'https://fixture.invalid', timers, now: () => Date.parse(stamp), sha256: digest,
      mint: () => { mintCount++; return '11111111-1111-4111-8111-111111111111'; }, isCurrent: context => privacy.isCurrent(context), onAuthorizationLoss() { privacy.close(); } });
    const privacy = createPrivacyController({ now: () => Date.parse(stamp), timers, mask() { runtime.close(); }, reveal() {}, cancelReads() { void client.cancelQueries(undefined, { revert: false, silent: true }); }, clearProtected() { clearWorkspaceQueries(client); }, verify: signal => runtime.verify(signal) });
    return { client, privacy, runtime };
  });
  useEffect(() => {
    const unsubscribe = environment.privacy.subscribe(() => { const snapshot = environment.privacy.getSnapshot(); if (snapshot.phase === 'available') environment.runtime.bind(snapshot.context); });
    void environment.privacy.refresh();
    return () => { unsubscribe(); environment.privacy.dispose(); environment.runtime.dispose(); environment.client.clear(); };
  }, [environment]);
  return <QueryClientProvider client={environment.client}><MemoryRouter initialEntries={['/sources']}><Shell privacy={environment.privacy} runtime={environment.runtime} fixture={false} /></MemoryRouter></QueryClientProvider>;
}
export const playBundleJourney = async ({ canvas, userEvent }: {
    readonly canvas: {
      findByRole(role: string, options: { readonly name: string; readonly exact?: boolean }): Promise<HTMLElement>;
      getByRole(role: string, options: { readonly name: string; readonly exact?: boolean }): HTMLElement;
      queryByRole(role: string, options: { readonly name: string }): HTMLElement | null;
      getByLabelText(name: string): HTMLElement;
      findByText(text: string | RegExp): Promise<HTMLElement>;
    };
    readonly userEvent: { click(element: HTMLElement): Promise<void>; upload(element: HTMLElement, files: readonly File[]): Promise<void> };
  }) => {
    const encode = (value: string) => new TextEncoder().encode(value);
    const content = '# Bundle evidence\n', contentHash = await digest(encode(content)), hash = 'a'.repeat(64);
    const manifest = JSON.stringify({ protocol: 'eliotr.normalized.v1',
      origin: { owner_system_id: 'bundle-owner', source_namespace_id: 'bundle-namespace', source_owner_generation: 'owner-generation', source_revision_ref: 'bundle-revision', source_view_ref: 'bundle-view', ownership_mode: 'immutable_import' },
      source: { logical_id: 'bundle-source', original_name: 'Bundle evidence', original_sha256: contentHash, origin_location_class: 'local_only', mime_type: 'text/markdown' },
      residency_and_disclosure: { scope_domain_id: 'scope-1', access_domain_id: 'access-1', confidentiality_domain_id: 'confidentiality-1', encryption_key_domain_id: 'encryption-1', retention_domain_id: 'retention-1', erasure_domain_id: 'erasure-1', disclosure_ceiling: 'owner-only', allowed_use: ['owner-workspace'] },
      normalization: { analyzer: 'analyzer-1', analyzer_version: '1.0.0', profile: 'profile-1', config_hash: hash, created_at: stamp },
      content: { markdown: 'content.md', markdown_sha256: contentHash }, capabilities: { text_ranges: true, pages: false, bounding_boxes: false, tables: false, figures: false }, quality: { state: 'high_fidelity', assurance_ceiling: 'ceiling-1', warnings: [] }, export: { purpose: 'owner workspace import', receipt_ref: 'receipt-1' } });
    const files = [new File([manifest], 'manifest.json'), new File([content], 'content.md'), new File([contentHash + ' *content.md\n' + await digest(encode(manifest)) + ' *manifest.json\n'], 'hashes.sha256')];
    await userEvent.click(await canvas.findByRole('button', { name: 'Import sources' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Saved bundle' }));
    await userEvent.upload(canvas.getByLabelText('Choose bundle files'), files);
    await userEvent.click(await canvas.findByRole('button', { name: 'Review bundle files' }));
    await canvas.findByText('content.md');
    const start = canvas.getByRole('button', { name: 'Start the import' });
    if (!(start instanceof HTMLButtonElement) || !start.disabled) throw new Error('Bundle began before explicit frozen-byte review');
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Review the exact bytes below before anything is uploaded.' }));
    start.click(); start.click();
    await canvas.findByText('Import outcome is unknown. Check the same import identity again.');
    if (canvas.queryByRole('button', { name: 'Start the import' })) throw new Error('Lost commit acknowledgement exposed a replacement import');
    await userEvent.click(canvas.getByRole('button', { name: 'Back to sources' }));
    await userEvent.click(canvas.getByRole('link', { name: 'Studio', exact: true }));
    await canvas.findByRole('heading', { name: 'Studio', exact: true });
    await userEvent.click(canvas.getByRole('link', { name: 'Sources', exact: true }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Import sources' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Saved bundle' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Check import status' }));
    await canvas.findByText('Committed with a verified receipt.');
    if (canvas.queryByRole('button', { name: 'Start the import' })) throw new Error('Committed readback exposed a new import');
    await userEvent.click(canvas.getByRole('button', { name: 'Clear this import' }));
    if (!(canvas.getByLabelText('Choose bundle files') instanceof HTMLInputElement)) throw new Error('Confirmed import could not release its local file selection');
};
