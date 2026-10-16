import { useEffect, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ProjectSummary, RawFileCaptureReceipt, RawNormalizedAdmissionResult } from '@eliotr/owner-api-client';
import { ImportPanel } from './ImportPanel';
import type { BoundWorkspaceApis } from './runtime';
import { createPrivacyController } from './privacy';
import { clearWorkspaceQueries, createWorkspaceQueryClient, protectedQueryKey } from '../query/client';
import type { ImportQueue } from './importQueue';

const generation = 'parallel-import-fixture', stamp = '2026-10-16T12:00:00.000Z';
const names = ['one.pdf', 'two.pdf', 'three.pdf'];
const digest = (index: number) => String(index).repeat(64);
function gate() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release: () => release() };
}
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(check: () => boolean) {
  for (let index = 0; index < 240; index++) {
    if (check()) return;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
  throw new Error('Parallel import did not reach its guarded checkpoint');
}

/** Actual ImportPanel, protected Query and attachment controller; typed API effects are gated. */
async function environment(unknownAttachment: boolean) {
  const client = createWorkspaceQueryClient(), captures = gate(), conversions = gate(), attachment = gate();
  const captureCalls: string[] = [], conversionCalls: string[] = [], admissions: string[] = [];
  const updates: { readonly revision: number; readonly sourceIds: readonly string[]; readonly key: string }[] = [];
  let captureReturns = 0, conversionReturns = 0, activeUpdates = 0, maximumUpdates = 0, committed = 0, minted = 0;
  let project: ProjectSummary = { project_id: 'project-parallel', title: 'Parallel PDFs', revision: 1,
    source_ids: ['source-existing'], created_at: stamp };
  const initialProject = project;
  const privacy = createPrivacyController({ now: () => Date.parse(stamp),
    timers: { setTimeout: () => 0, clearTimeout() {} }, mask() {}, reveal() {},
    cancelReads() { void client.cancelQueries(); }, clearProtected() { clearWorkspaceQueries(client); },
    verify: async () => ({ principal: 'parallel-owner', credentialGeneration: 'parallel-credential',
      deploymentGeneration: generation, expiresAt: '2027-01-01T00:00:00.000Z' }),
  });
  await privacy.refresh();
  const snapshot = privacy.getSnapshot();
  assert(snapshot.phase === 'available', 'Parallel fixture session did not verify');
  const context = snapshot.context;
  const indexFor = (capture: RawFileCaptureReceipt) => names.indexOf(capture.original_file_name) + 1;
  const raw: Pick<BoundWorkspaceApis['sources']['imports']['raw'], 'prepareRawFileSelection' | 'captureRawFile' |
    'createRawMarkdownIdempotencyKey' | 'convertRawFileToMarkdown' | 'admitRawFileToLibrary'> = {
    async prepareRawFileSelection(file, signal, namespace) {
      assert(!signal?.aborted && namespace === 'documents', 'Selected document namespace or signal changed');
      const index = names.indexOf(file.name) + 1;
      return { bytes: new Uint8Array(await file.arrayBuffer()), original_file_name: file.name,
        source_namespace_id: namespace, content_sha256: digest(index), content_type: file.type, size_bytes: file.size,
        idempotency_key: `raw-upload-${digest(index)}` };
    },
    async captureRawFile(selection) {
      assert(!captureCalls.includes(selection.idempotency_key), 'Capture POST repeated');
      captureCalls.push(selection.idempotency_key);
      await captures.promise; captureReturns++;
      const index = names.indexOf(selection.original_file_name) + 1;
      return { protocol: 'eliotr.raw-file-capture.v1', disposition: 'CAPTURED',
        capture_id: `raw-capture-${String(index).repeat(48)}`, idempotency_key: selection.idempotency_key,
        original_file_name: selection.original_file_name, content_sha256: selection.content_sha256,
        size_bytes: selection.size_bytes, content_type: selection.content_type, captured_at: stamp };
    },
    async createRawMarkdownIdempotencyKey(capture) { return `raw-markdown-${digest(indexFor(capture))}`; },
    async convertRawFileToMarkdown(capture, request) {
      assert(!conversionCalls.includes(request.idempotency_key), 'Conversion POST repeated');
      conversionCalls.push(request.idempotency_key);
      await conversions.promise; conversionReturns++;
      return { protocol: 'eliotr.raw-markdown-conversion.v1', state: 'COMPLETE',
        operation_id: digest(indexFor(capture)), capture_id: capture.capture_id, content_sha256: capture.content_sha256,
        output_sha256: digest(7), output_bytes: 20, format: 'markdown' };
    },
    async admitRawFileToLibrary(capture, conversion) {
      assert(!admissions.includes(capture.capture_id), 'Admission POST repeated');
      admissions.push(capture.capture_id);
      const index = indexFor(capture), operation = digest(index), revision = `revision-${index}`;
      const receipt = { operation_id: operation, manifest_sha256: digest(4), source_revision_ref: revision,
        normalized_artifact_ref: `normalized-${index}`, object_residency_key_digest: digest(5), decision: 'ADMITTED' as const,
        reason_codes: [], readback_sha256: digest(6), committed_at: stamp };
      return { protocol: 'eliotr.raw-normalized-admission.v1', admission_operation_id: operation,
        capture_id: capture.capture_id, conversion_operation_id: conversion.operation_id,
        candidate_ref: `raw-normalized-candidate:${digest(index)}`, state: 'COMMITTED', source_id: `source-${index}`,
        source_revision_ref: revision, source_view_ref: `snapshot-view:v1:${digest(index)}`, conversion_state: 'COMPLETE',
        admission_receipt: receipt, reason_codes: [], expires_at: '2027-01-01T00:00:00.000Z', updated_at: stamp,
      } satisfies RawNormalizedAdmissionResult;
    },
  };
  const projects: Pick<BoundWorkspaceApis['sources']['projects'], 'readProjects' | 'updateProject'> = {
    async readProjects() { return { protocol: 'eliotr.project-owner-list.v1', deployment_generation: generation, projects: [project] }; },
    async updateProject(id, title, sourceIds, revision, key) {
      assert(activeUpdates === 0 && id === project.project_id && title === project.title && revision === project.revision,
        'Membership attachment overlapped or used a stale CAS');
      assert(project.source_ids.every(source => sourceIds.includes(source)), 'Membership attachment lost an earlier source');
      activeUpdates++; maximumUpdates = Math.max(maximumUpdates, activeUpdates);
      updates.push({ revision, sourceIds: [...sourceIds], key });
      if (updates.length === 1) await attachment.promise;
      project = { ...project, source_ids: [...sourceIds], revision: revision + 1 };
      activeUpdates--;
      if (unknownAttachment && updates.length === 1) throw new TypeError('Lost membership acknowledgement');
      return { protocol: 'eliotr.project-owner.v1', state: 'UPDATED', deployment_generation: generation, project };
    },
  };
  const apis = { sources: { imports: { raw }, projects,
    namespaces: { async readSourceNamespaces() { return { protocol: 'eliotr.owner-namespaces.v1',
      deployment_generation: generation, profiles: [], namespaces: [
        { source_namespace_id: 'strict', title: 'Strict', minimum_quality_state: 'standard' },
        { source_namespace_id: 'documents', title: 'Documents', minimum_quality_state: 'degraded' },
      ] }; } },
    mintIntent() { minted++; return `11111111-1111-4111-8111-${String(minted).padStart(12, '0')}`; },
  } } as unknown as BoundWorkspaceApis;
  const prefix = protectedQueryKey(context, 'imports');
  const queue = () => client.getQueryData<ImportQueue>([...prefix, 'file-queue']);
  const memories = () => (queue()?.jobs ?? []).map(job => client.getQueryData<{
    readonly selection?: { readonly idempotency_key: string }; readonly request?: { readonly idempotency_key: string };
    readonly attachment?: { readonly phase: string; readonly intent: unknown };
  }>([...prefix, 'local-intent', job.id]));
  return { client, privacy, context, apis, initialProject, captures, conversions, attachment, queue, memories,
    captureCalls, conversionCalls, admissions, updates,
    counts: () => ({ captureReturns, conversionReturns, maximumUpdates, committed, minted }),
    project: () => project, commit() { committed++; },
    dispose() { captures.release(); conversions.release(); attachment.release(); privacy.dispose(); client.clear(); },
  };
}
type Environment = Awaited<ReturnType<typeof environment>>;
const environments = new WeakMap<HTMLElement, Environment>();
export function ParallelImportPreview({ unknownAttachment = false }: { readonly unknownAttachment?: boolean }) {
  const [state, setState] = useState<Environment>();
  useEffect(() => {
    let live = true, owned: Environment | undefined;
    void environment(unknownAttachment).then(value => { owned = value; if (live) setState(value); else value.dispose(); });
    return () => { live = false; owned?.dispose(); };
  }, [unknownAttachment]);
  if (!state) return <p>Preparing parallel imports</p>;
  return <div data-parallel-import ref={node => { if (node) environments.set(node, state); }}>
    <QueryClientProvider client={state.client}><ImportPanel apis={state.apis} privacy={state.privacy}
      context={state.context} locale="en" project={state.initialProject} onImportCommitted={() => state.commit()} />
    </QueryClientProvider>
  </div>;
}

interface PlayContext {
  readonly canvasElement: HTMLElement;
  readonly canvas: { findByRole(role: string, options: { readonly name: string; readonly exact?: boolean }): Promise<HTMLElement> };
  readonly userEvent: { click(element: HTMLElement): Promise<void>; upload(element: HTMLElement, files: File[]): Promise<void> };
}
export async function playParallelImport(test: PlayContext, unknown = false) {
  await test.userEvent.click(await test.canvas.findByRole('button', { name: 'Import sources', exact: true }));
  const root = test.canvasElement.querySelector<HTMLElement>('[data-parallel-import]');
  const f = root && environments.get(root);
  assert(f, 'Parallel import fixture missing');
  const input = test.canvasElement.querySelector<HTMLInputElement>('input[type="file"]');
  assert(input?.multiple, 'Multi-file picker missing');
  await test.userEvent.upload(input, names.map(name => new File([`%PDF fixture ${name}`], name, { type: 'application/pdf' })));
  await until(() => f.captureCalls.length === 2);
  assert(f.counts().captureReturns === 0 && f.queue()?.jobs[2]?.phase === 'waiting', 'Two capture chains did not start before the first finished');
  const selected = f.memories().slice(0, 2).map(memory => memory?.selection?.idempotency_key);
  assert(selected.every(Boolean) && new Set(selected).size === 2, 'Per-file protected capture identities were shared');
  f.captures.release();
  await until(() => f.conversionCalls.length === 2);
  assert(f.counts().conversionReturns === 0 && f.admissions.length === 0, 'Two conversion chains did not start before the first finished');
  f.conversions.release();
  await until(() => f.admissions.length === 2 && f.updates.length === 1);
  assert(f.memories().filter(memory => memory?.attachment).length === 1,
    'Attachment permit mismatch: ' + JSON.stringify({ queue: f.queue(), memories: f.memories(), updates: f.updates }));
  f.attachment.release();
  if (unknown) {
    await until(() => f.memories().some(memory => memory?.attachment?.phase === 'unknown'));
    const held = f.memories().find(memory => memory?.attachment)?.attachment?.intent;
    const frozen = JSON.stringify(held);
    await test.userEvent.click(await test.canvas.findByRole('button', { name: 'Cancel queue', exact: true }));
    assert(f.updates.length === 1 && f.captureCalls.length === 2 && f.counts().committed === 0 && f.counts().minted === 1,
      'Unknown attachment repeated an effect or advanced the queue');
    assert(f.memories().find(memory => memory?.attachment)?.attachment?.intent === held && JSON.stringify(held) === frozen,
      'Queue cancellation replaced the uncertain snapshot/key');
    await test.userEvent.click(await test.canvas.findByRole('button', { name: 'Check project', exact: true }));
    await until(() => f.counts().committed === 2);
    assert(f.captureCalls.length === 2 && f.conversionCalls.length === 2 && Number(f.admissions.length) === 2 && Number(f.updates.length) === 2,
      'Manual readback retried the PUT/POST or started the cancelled file');
    assert(f.queue()?.jobs[2]?.phase === 'waiting' && f.queue()?.cancelled, 'Cancelled file advanced');
  } else {
    await until(() => f.counts().committed === 3);
    assert(f.captureCalls.length === 3 && f.conversionCalls.length === 3 && Number(f.admissions.length) === 3, 'A file pipeline was duplicated or skipped');
    assert(f.project().source_ids.join(',') === 'source-1,source-2,source-3,source-existing', 'Project lost an imported or original source');
  }
  assert(f.counts().maximumUpdates === 1 && f.updates.every((update, index) => update.revision === index + 1), 'Attachment CAS snapshots were not serialized');
  assert(new Set(f.updates.map(update => update.key)).size === f.updates.length, 'Different attachments shared an intent key');
}
