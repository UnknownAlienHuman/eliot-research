import { FiniteReadExportPreview, playReadsNoEffects, playFailedRequiredSectionNoExport } from "./FiniteReadExportPreview";
import { FiniteTruthDisclosurePreview, playCapabilityConnectionTruth, playBoundedRootDisclosure } from "./FiniteTruthDisclosurePreview";
import { FiniteExcerptPreview, playFiniteExcerptLifecycle } from "./FiniteExcerptPreview";
import {
  FiniteReaderPreview,
  playStaleLibraryHolder,
  playStaleRevisionHolder,
  playPrivacyLateHistoryReplay,
  playSameEpochForeignProject,
  playSameEpochForeignSource,
} from "./FiniteReaderPreview";

import { StrictMode, useEffect, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createWorkspaceRuntime } from "./runtime";
import { createWorkspaceQueryClient, clearWorkspaceQueries } from "../query/client";
import { MemoryRouter } from "react-router";
import { Shell } from "./Shell";
import { FixtureWorkspace } from "./FixtureWorkspace";
import { createPrivacyController } from "./privacy";
import { BundlePreview, playBundleJourney } from "./ImportBundlePreview";
import { ResearchPreview, playResearchJourney } from "./ResearchPreview";
import { StudioPreview, playStudioJourney } from "./StudioPreview";
import { ArtifactActionsPreview, playArtifactActionsJourney } from "./ArtifactActionsPreview";
import { WorkspaceLinkPreview, playWorkspaceLinkJourney } from "./WorkspaceLinkJourney";

function ShellPreview() {
  const [privacy] = useState(() => createPrivacyController({
    now: () => Date.parse("2026-10-09T00:00:00.000Z"),
    timers: { setTimeout: () => 0, clearTimeout() {} },
    mask() {}, reveal() {}, cancelReads() {}, clearProtected() {},
    async verify() { return { principal: "synthetic-owner", credentialGeneration: "fixture-only", deploymentGeneration: "fixture-only", expiresAt: "2027-01-01T00:00:00.000Z" }; },
  }));
  useEffect(() => { void privacy.refresh(); }, [privacy]);
  return <StrictMode><MemoryRouter initialEntries={["/research"]}><Shell privacy={privacy} fixture fixtureOutlet={FixtureWorkspace} /></MemoryRouter></StrictMode>;
}
export default { title: "Workspace/Shell", component: ShellPreview, parameters: { layout: "fullscreen" } };
export const ArtifactActionsJourney = { render: () => <ArtifactActionsPreview />, play: playArtifactActionsJourney };
export const LiveResearchJourney = { render: () => <ResearchPreview />, play: playResearchJourney };
export const LiveStudioJourney = { render: () => <StudioPreview />, play: playStudioJourney };
export const WorkspaceLinkJourney = { render: () => <WorkspaceLinkPreview />, play: playWorkspaceLinkJourney };
export const StrictModeJourney = {
  async play({ canvas }: { readonly canvas: { getByRole(role: string, options?: { readonly name?: string; readonly exact?: boolean }): HTMLElement; findByRole(role: string, options?: { readonly name?: string; readonly exact?: boolean }): Promise<HTMLElement> } }) {
    if (canvas.getByRole("heading", { name: "Research", exact: true }).tabIndex !== -1) throw new Error("Route heading needs programmatic focus");
    const navigation = canvas.getByRole("navigation");
    const studio = navigation.querySelector<HTMLAnchorElement>('a[href="/studio"]');
    if (!studio) throw new Error("Stable Studio destination missing");
    studio.click();
    const heading = await canvas.findByRole("heading", { name: "Studio", exact: true });
    if (heading !== document.activeElement) throw new Error("Route commit did not focus the new heading");
    if (studio.getAttribute("aria-current") !== "page") throw new Error("Current destination is not announced");
  },
};

const liveDocumentText = "# Evidence in context\n\nThe selected version is immutable. A later source version does not rewrite a saved report.";
const liveDocumentDigest = "f9c184057405381672d4cc612210b2f672a15479948f5f700a64066eb3b48768";
function LiveSourcesPreview({ erasureJourney = false, importJourney = false, erasureReadFailure = false }: { readonly erasureJourney?: boolean; readonly importJourney?: boolean; readonly erasureReadFailure?: boolean }) {
  const [environment] = useState(() => {
    const client = createWorkspaceQueryClient();
    const generation = "live-fixture";
    const stamp = "2026-10-09T12:00:00.000Z";
    const revision = "revision-live-1";
    const source = "source-live-1";
    let captureCalls = 0, conversionCalls = 0, originalConversion: string | undefined;
    let captured: { protocol: 'eliotr.raw-file-capture.v1'; disposition: 'CAPTURED'; capture_id: string; idempotency_key: string; original_file_name: string; content_sha256: string; size_bytes: number; content_type: string; captured_at: string } | undefined;
    let intentCount = 0, prepareCount = 0, executeCount = 0, statusCount = 0;
    const erasureRef = { id: "erasure-live-1", revision: 1 };
    const erasureReceipt = { protocol: "erc.privacy.erasure.v1", erasure_ref: erasureRef, state: "COMPLETE",
      requested_locations: ["CanonicalPayload"], completed_locations: ["CanonicalPayload"], blocked_locations: [],
      purge_ledger_entry_ref: "ledger-live-1", issued_at: stamp };
    const timers = { setTimeout: () => 0, clearTimeout() {} };
    const json = (data: unknown) => new Response(JSON.stringify({ data, trace_id: "live-trace-1", deployment_generation: generation }), { headers: { "content-type": "application/json" } });
    const fetchFixture: typeof fetch = async (input, init) => {
      const url = new URL(String(input), "https://fixture.invalid");
      if (importJourney && url.pathname === '/api/v1/library/namespaces') return json({ protocol: 'eliotr.owner-namespaces.v1', profiles: [], namespaces: [{ source_namespace_id: 'workspace-live-1', title: 'Imported research' }] });
      if (importJourney && url.pathname === '/api/v1/ingest/raw') {
        if (init?.method === 'POST') {
          captureCalls++; const headers = new Headers(init.headers);
          if (captureCalls !== 1 || !(init.body instanceof Uint8Array) || headers.get('x-eliotr-csrf') !== '1' || headers.get('x-eliotr-source-namespace-id') !== 'workspace-live-1') throw new Error('Capture repeated or request binding changed');
          captured = { protocol: 'eliotr.raw-file-capture.v1', disposition: 'CAPTURED', capture_id: 'raw-capture-' + 'b'.repeat(48), idempotency_key: headers.get('idempotency-key') ?? '', original_file_name: decodeURIComponent(headers.get('x-eliotr-original-file-name') ?? ''), content_sha256: headers.get('x-eliotr-content-sha256') ?? '', size_bytes: init.body.byteLength, content_type: headers.get('content-type') ?? '', captured_at: stamp };
          throw new TypeError('Synthetic lost capture acknowledgement');
        }
        if (!captured || new Headers(init?.headers).get('idempotency-key') !== captured.idempotency_key) throw new Error('Capture readback replaced identity');
        return json(captured);
      }
      if (importJourney && captured && url.pathname === `/api/v1/ingest/raw/${captured.capture_id}/markdown`) {
        conversionCalls++; const body = String(init?.body);
        const request: unknown = JSON.parse(body);
        if (!request || typeof request !== 'object' || !('idempotency_key' in request) || typeof request.idempotency_key !== 'string' || !request.idempotency_key.startsWith('raw-markdown-') || intentCount !== 0) throw new Error('Conversion key was invented or reused capture identity');
        if (conversionCalls === 1) { originalConversion = body; throw new TypeError('Synthetic lost conversion acknowledgement'); }
        if (conversionCalls !== 2 || body !== originalConversion) throw new Error('Reconciliation changed the original request');
        return json({ protocol: 'eliotr.raw-markdown-conversion.v1', state: 'UNKNOWN', operation_id: 'e'.repeat(64), capture_id: captured.capture_id, content_sha256: captured.content_sha256, failure_code: 'PROVIDER_UNCERTAIN' });
      }
      if (url.pathname === "/api/v1/system/health") return json({ ready: true, deployment_generation: generation, core_schema_generation: "schema-1", search_schema_generation: "schema-1", blocking_reason_codes: [], checked_at: stamp });
      if (url.pathname === "/api/v1/system/session") return json({ protocol: "eliotr.owner-session.v1", principal_ref: "live-owner", credential_generation: "live-credential", client_class: "owner_pwa", expires_at: "2027-01-01T00:00:00.000Z" });
      if (erasureJourney && url.pathname === "/api/v1/library/erasure/prepare") {
        prepareCount++;
        if (prepareCount !== 1 || intentCount !== 1 || init?.method !== "POST") throw new Error("Deletion review identity was repeated");
        const body: unknown = JSON.parse(String(init.body));
        if (!body || typeof body !== "object" || !("idempotency_key" in body) || body.idempotency_key !== "11111111-1111-4111-8111-111111111111") throw new Error("Deletion review lost its intent");
        return json({ protocol: "eliotr.owner-erasure-preview.v1", source_id: source, source_title: "How source versions preserve evidence", revision_targets: [revision],
          request: { protocol: "eliotr.owner-erasure.v1", permission_ref: { id: "permission-live-1", revision: 1 },
            request: { protocol: "erc.privacy.erasure.v1", erasure_ref: erasureRef, requested_by_principal_ref: "live-owner", exact_subject_refs: ["subject-live-1"],
              required_locations: ["CanonicalPayload"], legal_basis_ref: "basis-live-1", admitted_at: stamp, deadline: "2026-11-09T12:00:00.000Z" } } });
      }
      if (erasureJourney && url.pathname === "/api/v1/library/erasure") {
        if (init?.method === "POST") {
          executeCount++;
          if (executeCount !== 1 || new Headers(init.headers).get("x-eliotr-csrf") !== "1") throw new Error("Destructive effect repeated or CSRF absent");
          throw new TypeError("Synthetic lost acknowledgement");
        }
      }
      if (erasureJourney && url.pathname === `/api/v1/library/erasure/${erasureRef.id}/${erasureRef.revision}`) {
        statusCount++;
        if (executeCount !== 1 || prepareCount !== 1 || intentCount !== 1) throw new Error("Saved readback identity or effect count changed");
        if (erasureReadFailure && statusCount === 2) throw new TypeError("Synthetic unavailable readback after an unknown result");
        return json({ protocol: "eliotr.owner-erasure-status.v1", erasure_ref: erasureRef, state: statusCount === 1 ? "UNKNOWN" : "COMPLETE",
          ...(statusCount > 1 ? { receipt: erasureReceipt } : {}) });
      }
      if (url.pathname === "/api/v1/research/projects") return json({ protocol: "eliotr.project-owner-list.v1", projects: [{ protocol: "eliotr.project-owner.v1", project_ref: { id: "project-live-1", revision: 1 }, title: "Evidence in context", revision: 1, owner_principal_ref: "live-owner", deployment_generation: generation, source_ids: [source], created_at: stamp }] });
      if (url.pathname === "/api/v1/research/catalog") return json({ projects: [{ id: "project-live-1", title: "Evidence in context", generation }], sources: [{ id: source, title: "How source versions preserve evidence", readiness_ref: "readiness:source-live-1:observation-1" }] });
      if (url.pathname === "/api/v1/library/readiness") return json({
        protocol: "eliotr.library-readiness.v1", source_id: source, source_revision_ref: revision,
        deployment_generation: generation, catalog_generation: "1", observed_at: stamp, quality_state: "high_fidelity", readiness_basis: "ACTIVE_VERIFIED",
        currentness: { verification: "VERIFIED", value: { source_revision_ref: revision, owner_system_id: "owner-system", source_owner_generation: "owner-generation", source_view_ref: "source-view", observation_freshness: "current_confirmed", observed_at: stamp, gap_refs: [] } },
        channels: ["exact_ready", "lexical_ready", "semantic_ready"].map(channel => ({ channel, state: "ready", source_revision_ref: revision, reason_codes: [], observed_at: stamp, generation: "channel-1", receipt_ref: "readiness-receipt" }))
      });
      if (url.pathname === "/api/v1/library/revisions") return json({ protocol: "eliotr.source-revisions.v1", source_id: source, head_revision_ref: revision, observed_at: stamp, readiness_basis: "RECORDED_ONLY", revisions: [{ source_revision_ref: revision, content_sha256: liveDocumentDigest, captured_at: stamp, admitted_at: stamp, quality_state: "high_fidelity", currentness_state: "current_confirmed", readiness: [] }] });
      if (url.pathname === "/api/v1/library/content" && url.searchParams.get("source_revision_ref") === revision) return new Response(liveDocumentText, { headers: { "content-type": "text/plain", "content-length": String(new TextEncoder().encode(liveDocumentText).byteLength), "x-eliotr-source-revision": revision, "x-eliotr-deployment-generation": generation, "x-eliotr-content-sha256": liveDocumentDigest } });
      throw new Error("Unexpected fixture request: " + url.pathname);
    };
    const runtime = createWorkspaceRuntime({
      fetch: fetchFixture, baseUrl: "https://fixture.invalid", timers, now: () => Date.parse(stamp), mint: () => { intentCount++; return "11111111-1111-4111-8111-111111111111"; },
      async sha256(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())), value => value.toString(16).padStart(2, "0")).join(""); },
      isCurrent: context => privacy.isCurrent(context), onAuthorizationLoss() { privacy.close(); },
    });
    const privacy = createPrivacyController({
      now: () => Date.parse(stamp), timers, mask() { runtime.close(); }, reveal() {},
      cancelReads() { void client.cancelQueries(undefined, { revert: false, silent: true }); }, clearProtected() { clearWorkspaceQueries(client); },
      verify: signal => runtime.verify(signal),
    });
    return { client, privacy, runtime };
  });
  useEffect(() => {
    const unsubscribe = environment.privacy.subscribe(() => {
      const snapshot = environment.privacy.getSnapshot();
      if (snapshot.phase === "available") environment.runtime.bind(snapshot.context);
    });
    void environment.privacy.refresh();
    return () => { unsubscribe(); environment.privacy.dispose(); environment.runtime.dispose(); environment.client.clear(); };
  }, [environment]);
  return <QueryClientProvider client={environment.client}><MemoryRouter initialEntries={["/sources"]}><Shell privacy={environment.privacy} runtime={environment.runtime} fixture={false} /></MemoryRouter></QueryClientProvider>;
}
export const LiveSourcesJourney = {
  render: () => <LiveSourcesPreview />,
  play: async ({ canvas, userEvent }: {
    readonly canvas: {
      findByRole(role: string, options: { readonly name: string }): Promise<HTMLElement>;
      getByRole(role: string, options: { readonly name: string }): HTMLElement;
      queryByRole(role: string): HTMLElement | null;
      findByText(text: RegExp): Promise<HTMLElement>;
    };
    readonly userEvent: { click(element: HTMLElement): Promise<void>; selectOptions(element: HTMLElement, value: string): Promise<void> };
  }) => {
    await userEvent.selectOptions(await canvas.findByRole("combobox", { name: "Project" }), "project-live-1");
    await userEvent.click(await canvas.findByRole("button", { name: "How source versions preserve evidence" }));
    const readiness = await canvas.findByRole("region", { name: "Search readiness" });
    const verified = await canvas.findByText(/Currentness verified/);
    if (!readiness.contains(verified)) throw new Error("Independent readiness did not reach the actual source panel");
    for (const label of ["Exact", "Lexical", "Semantic"]) {
      const channel = Array.from(readiness.querySelectorAll("dt")).find(term => term.textContent === label);
      if (channel?.nextElementSibling?.textContent !== "Ready") throw new Error("Readiness did not preserve the independently verified " + label + " channel");
    }
    const read = await canvas.findByRole("button", { name: "Read version 1" });
    await userEvent.click(read);
    const dialog = await canvas.findByRole("dialog", { name: "How source versions preserve evidence" });
    const text = await canvas.findByText(/The selected version is immutable/);
    if (!dialog.contains(text)) throw new Error("Verified text did not reach the actual reader dialog");
    await userEvent.click(canvas.getByRole("button", { name: "Back to sources" }));
    if (canvas.queryByRole("dialog")) throw new Error("Back did not close the source document");
    if (read !== document.activeElement) throw new Error("Back did not restore the reader opener");
  },
};

export const LiveErasureJourney = {
  render: () => <LiveSourcesPreview erasureJourney />,
  play: async ({ canvas, userEvent }: {
    readonly canvas: {
      findByRole(role: string, options: { readonly name: string }): Promise<HTMLElement>;
      getByRole(role: string, options: { readonly name: string; readonly exact?: boolean }): HTMLElement;
      queryByRole(role: string, options?: { readonly name: string }): HTMLElement | null;
      findByText(text: RegExp): Promise<HTMLElement>;
    };
    readonly userEvent: { click(element: HTMLElement): Promise<void>; selectOptions(element: HTMLElement, value: string): Promise<void> };
  }) => {
    await userEvent.selectOptions(await canvas.findByRole("combobox", { name: "Project" }), "project-live-1");
    await userEvent.click(await canvas.findByRole("button", { name: "How source versions preserve evidence" }));
    await userEvent.click(await canvas.findByText(/Manage selected source/));
    const opener = await canvas.findByRole("button", { name: "Review deletion" });
    await userEvent.click(opener);
    const confirm = await canvas.findByRole("button", { name: "Confirm deletion" });
    // Two immediate real gestures must share one destructive dispatch, before a React render.
    confirm.click(); confirm.click();
    await canvas.findByRole("button", { name: "Refresh status" });
    if (canvas.queryByRole("button", { name: "Confirm deletion" })) throw new Error("Uncertain result exposed repeat confirmation");
    await userEvent.click(canvas.getByRole("button", { name: "Back to sources" }));
    if (opener !== document.activeElement) throw new Error("Deletion review did not restore opener focus");
    await userEvent.click(canvas.getByRole("link", { name: "Studio", exact: true }));
    await canvas.findByRole("heading", { name: "Studio" });
    await userEvent.click(canvas.getByRole("link", { name: "Sources", exact: true }));
    await userEvent.click(await canvas.findByRole("button", { name: "Check deletion request" }));
    if (canvas.queryByRole("button", { name: "Confirm deletion" })) throw new Error("Reopened saved request exposed repeat confirmation");
    await userEvent.click(canvas.getByRole("button", { name: "Refresh status" }));
    await canvas.findByText(/The deletion result is unknown/);
    if (canvas.queryByRole("button", { name: "Confirm deletion" })) throw new Error("Unknown saved status exposed repeat confirmation");
    await userEvent.click(canvas.getByRole("button", { name: "Refresh status" }));
    await canvas.findByText(/Deletion confirmed by the saved server receipt/);
    if (canvas.queryByRole("button", { name: "Confirm deletion" })) throw new Error("Completed readback exposed repeat confirmation");
  },
};

export const LiveErasureReadbackFailure = {
  render: () => <LiveSourcesPreview erasureJourney erasureReadFailure />,
  play: async ({ canvas, userEvent }: Parameters<typeof LiveErasureJourney.play>[0]) => {
    await userEvent.selectOptions(await canvas.findByRole("combobox", { name: "Project" }), "project-live-1");
    await userEvent.click(await canvas.findByRole("button", { name: "How source versions preserve evidence" }));
    await userEvent.click(await canvas.findByText(/Manage selected source/));
    await userEvent.click(await canvas.findByRole("button", { name: "Review deletion" }));
    const confirm = await canvas.findByRole("button", { name: "Confirm deletion" });
    confirm.click(); confirm.click();
    await userEvent.click(await canvas.findByRole("button", { name: "Refresh status" }));
    await canvas.findByText(/The deletion result is unknown/);
    await userEvent.click(canvas.getByRole("button", { name: "Refresh status" }));
    await canvas.findByText(/The deletion status could not be read/);
    if (canvas.queryByRole("button", { name: "Confirm deletion" })) throw new Error("Failed readback exposed a repeated destructive action");
    await userEvent.click(canvas.getByRole("button", { name: "Refresh status" }));
    await canvas.findByText(/Deletion confirmed by the saved server receipt/);
    if (canvas.queryByRole("button", { name: "Confirm deletion" })) throw new Error("Completed recovery exposed a new deletion");
  },
};

export const LiveBundleJourney = {
  render: () => <BundlePreview />,
  play: playBundleJourney,
};

export const LiveImportJourney = {
  render: () => <LiveSourcesPreview importJourney />,
  play: async ({ canvas, userEvent }: {
    readonly canvas: {
      findByRole(role: string, options: { readonly name: string; readonly exact?: boolean }): Promise<HTMLElement>;
      getByRole(role: string, options: { readonly name: string; readonly exact?: boolean }): HTMLElement;
      queryByRole(role: string, options: { readonly name: string }): HTMLElement | null;
      findByLabelText(name: string): Promise<HTMLElement>;
      getByLabelText(name: string): HTMLElement;
      findByText(text: string): Promise<HTMLElement>;
    };
    readonly userEvent: {
      click(element: HTMLElement): Promise<void>;
      selectOptions(element: HTMLElement, value: string): Promise<void>;
      upload(element: HTMLElement, file: File): Promise<void>;
      type(element: HTMLElement, value: string): Promise<void>;
    };
  }) => {
    await userEvent.click(await canvas.findByRole('button', { name: 'Import sources' }));
    await userEvent.selectOptions(await canvas.findByLabelText('Save the file in'), 'workspace-live-1');
    await userEvent.upload(canvas.getByLabelText('Choose a file'), new File(['# Imported evidence\n'], 'Imported report.md', { type: 'text/markdown' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Review the selected file' }));
    const capture = await canvas.findByRole('button', { name: 'Capture the selected file' });
    capture.click(); capture.click();
    await userEvent.click(await canvas.findByRole('button', { name: 'Check the previous capture' }));
    await canvas.findByText('Imported report.md');
    if (canvas.queryByRole('button', { name: 'Process the captured file' })) throw new Error('Processing appeared before explicit limits');
    await userEvent.type(await canvas.findByLabelText('Maximum result size (bytes)'), '131072');
    await userEvent.type(canvas.getByLabelText('Maximum processing tokens'), '1024');
    await userEvent.type(canvas.getByLabelText('Time limit (milliseconds)'), '1000');
    await userEvent.click(canvas.getByRole('button', { name: 'Review processing options' }));
    const process = await canvas.findByRole('button', { name: 'Process the captured file' });
    process.click(); process.click();
    await canvas.findByRole('button', { name: 'Check processing status' });
    await userEvent.click(canvas.getByRole('button', { name: 'Back to sources' }));
    await userEvent.click(canvas.getByRole('link', { name: 'Studio', exact: true }));
    await canvas.findByRole('heading', { name: 'Studio', exact: true });
    await userEvent.click(canvas.getByRole('link', { name: 'Sources', exact: true }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Import sources' }));
    if (canvas.queryByRole('button', { name: 'Process the captured file' })) throw new Error('Unknown processing exposed a new operation');
    await userEvent.click(await canvas.findByRole('button', { name: 'Check processing status' }));
    await canvas.findByText('Outcome not yet known');
    if (canvas.queryByRole('button', { name: 'Add to Library' })) throw new Error('Unknown processing exposed admission');
    if (canvas.queryByRole('button', { name: 'Capture the selected file' })) throw new Error('Unknown processing exposed new capture');
  },
};

export const LiveReaderStaleLibraryHolder = {
  render: () => <FiniteReaderPreview key="reader-stale-library-holder" />,
  play: playStaleLibraryHolder,
};

export const LiveReaderStaleRevisionHolder = {
  render: () => <FiniteReaderPreview key="reader-stale-revision-holder" />,
  play: playStaleRevisionHolder,
};

export const LiveReaderPrivacyLateHistoryReplay = {
  render: () => <FiniteReaderPreview key="reader-privacy-late-history-replay" />,
  play: playPrivacyLateHistoryReplay,
};

export const LiveReaderSameEpochForeignProject = {
  render: () => <FiniteReaderPreview key="reader-same-epoch-foreign-project" />,
  play: playSameEpochForeignProject,
};

export const LiveReaderSameEpochForeignSource = {
  render: () => <FiniteReaderPreview key="reader-same-epoch-foreign-source" />,
  play: playSameEpochForeignSource,
};

export const LiveExcerptPrivacyLateResponse = {
  render: () => <FiniteExcerptPreview key="excerpt-privacy-late-response" />,
  play: playFiniteExcerptLifecycle,
};

export const LiveCanonicalReadsNoEffects = { render: () => <FiniteReadExportPreview key="canonical-reads-no-effects" />, play: playReadsNoEffects };
export const LiveFailedRequiredSectionNoExport = { render: () => <FiniteReadExportPreview key="failed-required-section" scenario="failed-required-section-no-export" />, play: playFailedRequiredSectionNoExport };
export const LiveCapabilityConnectionTruth = { render: () => <FiniteTruthDisclosurePreview key="capability-connection-truth" />, play: playCapabilityConnectionTruth };
export const LiveBoundedRootDisclosure = { render: () => <FiniteTruthDisclosurePreview key="bounded-root-disclosure" scenario="disclosure" />, play: playBoundedRootDisclosure };
