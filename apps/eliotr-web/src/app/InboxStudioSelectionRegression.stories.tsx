import { useEffect, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { VersionedRef, WikiProposalListView, WikiProposalReadView } from "@eliotr/owner-api-client";
import { Shell } from "./Shell";
import { createWorkspaceRuntime } from "./runtime";
import { createPrivacyController } from "./privacy";
import { clearWorkspaceQueries, createWorkspaceQueryClient, protectedQueryKey } from "../query/client";

const stamp = "2026-10-14T12:00:00.000Z";
const generation = "inbox-studio-selection-regression";
const firstId = "wiki-proposal-first";
const secondId = "wiki-proposal-second";
const sharedTitle = "Shared title for two distinct proposals";
const firstBody = "This is the first proposal body.";
const secondBody = "This is the exact second proposal body.";
const uncertainKey = "preserved-uncertain-owner-key";
const encode = (value: string) => new TextEncoder().encode(value);
const digest = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer))]
    .map(value => value.toString(16).padStart(2, "0")).join("");

interface RequestEvent { readonly method: string; readonly path: string }
interface StudioIntentFixture {
  readonly kind: "edit";
  readonly base: WikiProposalReadView;
  readonly title: string;
  readonly body: string;
  readonly note: string;
  readonly key: string;
  readonly phase: "unknown";
}
interface StudioMemoryFixture { readonly selected?: VersionedRef; readonly intent?: StudioIntentFixture }
interface InboxStudioEnvironment {
  readonly client: ReturnType<typeof createWorkspaceQueryClient>;
  readonly privacy: ReturnType<typeof createPrivacyController>;
  readonly runtime: ReturnType<typeof createWorkspaceRuntime>;
  readonly stopBinding: () => void;
  requestEventCount(): number;
  requestEventsSince(index: number): readonly RequestEvent[];
  mintedKeyCount(): number;
  postCount(): number;
  seedUnknownIntent(): void;
  readStudioMemory(): StudioMemoryFixture | undefined;
}

const environments = new WeakMap<HTMLElement, InboxStudioEnvironment>();

function proposalInfo(id: string) {
  if (id === firstId) return { pageId: "wiki-page-first", body: firstBody };
  if (id === secondId) return { pageId: "wiki-page-second", body: secondBody };
  return undefined;
}

/** Composed Storybook harness follows StudioPublishReadbackRegression: shared owner client, privacy, shell and route. */
function createInboxStudioEnvironment(): InboxStudioEnvironment {
  const client = createWorkspaceQueryClient();
  const timers = { setTimeout: () => 0, clearTimeout() {} };
  const events: RequestEvent[] = [];
  const proposalViews = new Map<string, WikiProposalReadView>();
  let mintedKeys = 0, posts = 0;

  const json = (data: unknown) => new Response(JSON.stringify({
    data, trace_id: "inbox-studio-selection-trace", deployment_generation: generation,
  }), { headers: { "content-type": "application/json" } });

  const page = async (id: string): Promise<WikiProposalReadView["page"]> => {
    const info = proposalInfo(id);
    if (!info) throw new Error(`Unexpected Wiki proposal identity: ${id}`);
    return {
      page_ref: { id: info.pageId, revision: 2 },
      page_type: "Topic",
      title: sharedTitle,
      scope_snapshot_ref: { id: `wiki-scope-${id}`, revision: 1 },
      body_object_ref: `wiki-body-${id}`,
      body_sha256: await digest(encode(info.body)),
      statement_labels: {},
      evidence_map_ref: `wiki-map-${id}`,
      counterposition_refs: [],
      coverage_receipt_ref: { id: `wiki-coverage-${id}`, revision: 1 },
      limitations: [],
      dependency_refs: [],
      generator_generation: "wiki-generator-inbox-selection",
      status: "DRAFT",
      supersedes_ref: { id: info.pageId, revision: 1 },
      publication_metadata: {},
      created_at: stamp,
    };
  };

  const summary = (id: string): WikiProposalListView["items"][number] => {
    const info = proposalInfo(id);
    if (!info) throw new Error(`Unexpected Wiki proposal summary: ${id}`);
    return {
      proposal_ref: { id, revision: 1 },
      page_ref: { id: info.pageId, revision: 2 },
      title: sharedTitle,
      page_type: "Topic",
      risk_class: "D2_ANALYTICAL",
      state: "PROPOSED",
      created_at: stamp,
    };
  };

  const readProposal = async (id: string) => {
    const loadedPage = await page(id);
    const data = {
      protocol: "eliotr.wiki-proposal-read.v2",
      proposal_ref: { id, revision: 1 },
      page: loadedPage,
      risk_class: "D2_ANALYTICAL",
      state: "PROPOSED",
      source_freshness: { state: "CURRENT_REVISIONS", checked_at: stamp, changed_sources: [] },
    } satisfies Omit<WikiProposalReadView, "deployment_generation">;
    const view: WikiProposalReadView = { ...data, deployment_generation: generation };
    proposalViews.set(id, view);
    return json(data);
  };

  const readBody = async (id: string) => {
    const info = proposalInfo(id);
    if (!info) throw new Error(`Unexpected Wiki proposal body read: ${id}`);
    const loadedPage = await page(id);
    return new Response(info.body, { headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(encode(info.body).byteLength),
      "x-eliotr-wiki-proposal-ref": encodeURIComponent(`${id}:1`),
      "x-eliotr-wiki-page-ref": encodeURIComponent(`${info.pageId}:2`),
      "x-eliotr-body-sha256": loadedPage.body_sha256,
      "x-eliotr-deployment-generation": generation,
    } });
  };

  const fetchFixture: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "https://fixture.invalid");
    const method = (init?.method ?? "GET").toUpperCase();
    events.push({ method, path: url.pathname });
    if (method === "POST") {
      posts++;
      throw new Error("Inbox Open and intent recovery must not dispatch a mutation");
    }
    if (url.pathname === "/api/v1/system/health") return json({
      ready: true, deployment_generation: generation, core_schema_generation: "schema-1",
      search_schema_generation: "schema-1", blocking_reason_codes: [], checked_at: stamp,
    });
    if (url.pathname === "/api/v1/system/session") return json({
      protocol: "eliotr.owner-session.v1", principal_ref: "inbox-story-owner",
      credential_generation: "inbox-story-credential", client_class: "owner_pwa",
      expires_at: "2027-01-01T00:00:00.000Z",
    });
    if (url.pathname === "/api/v1/research/projects") return json({
      protocol: "eliotr.project-owner-list.v1", projects: [],
    });
    if (url.pathname === "/api/v1/research/runs") return json({
      protocol: "eliotr.research-runs.v3", runs: [], saved_drafts: [],
      configuration_state: "INSTALLED", checked_at: stamp,
    });
    if (url.pathname === "/api/v1/system/research-configuration") return json({
      protocol: "eliotr.research-configuration-readiness.v1", configuration: "present",
      model_transport: "available", qualification_state: "current", run_readiness: "ready",
      readiness_reason: "QUALIFICATION_PROOFS_CURRENT", model_route: "research-route",
      qualification_expires_at: "2027-01-01T00:00:00.000Z", missing_fields: [], invalid_fields: [], checked_at: stamp,
    });
    if (url.pathname === "/api/v1/research/wiki/proposals") return json({
      protocol: "eliotr.wiki-proposals.v1", items: [summary(firstId), summary(secondId)], has_more: false,
    });
    const proposalMatch = /^\/api\/v1\/research\/wiki\/proposals\/(wiki-proposal-first|wiki-proposal-second)(\/body)?$/u.exec(url.pathname);
    if (proposalMatch) {
      const id = proposalMatch[1];
      if (!id) throw new Error("Missing Wiki proposal id");
      return proposalMatch[2] ? readBody(id) : readProposal(id);
    }
    throw new Error(`Unexpected inbox-selection fixture request: ${url.pathname}`);
  };

  const runtime = createWorkspaceRuntime({
    fetch: fetchFixture,
    baseUrl: "https://fixture.invalid",
    timers,
    now: () => Date.parse(stamp),
    sha256: digest,
    mint() {
      mintedKeys++;
      return `00000000-0000-4000-8000-${String(mintedKeys).padStart(12, "0")}`;
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
    if (snapshot.phase === "available") runtime.bind(snapshot.context);
  });

  return {
    client, privacy, runtime, stopBinding,
    requestEventCount: () => events.length,
    requestEventsSince(index) { return events.slice(index); },
    mintedKeyCount: () => mintedKeys,
    postCount: () => posts,
    seedUnknownIntent() {
      const snapshot = privacy.getSnapshot();
      if (snapshot.phase !== "available" || !privacy.isCurrent(snapshot.context)) throw new Error("Owner session is not current");
      const base = proposalViews.get(secondId);
      if (!base) throw new Error("The exact second proposal read is missing");
      const memoryKey = [...protectedQueryKey(snapshot.context, "studio"), "local-intent"];
      const current = client.getQueryData<StudioMemoryFixture>(memoryKey) ?? {};
      client.setQueryData<StudioMemoryFixture>(memoryKey, {
        ...current,
        selected: { id: secondId, revision: 1 },
        intent: {
          kind: "edit", base, title: "Owner-held edit", body: "Preserve this body", note: "uncertain request",
          key: uncertainKey, phase: "unknown",
        },
      });
    },
    readStudioMemory() {
      const snapshot = privacy.getSnapshot();
      if (snapshot.phase !== "available") return undefined;
      return client.getQueryData<StudioMemoryFixture>([...protectedQueryKey(snapshot.context, "studio"), "local-intent"]);
    },
  };
}

function InboxStudioSelectionPreview() {
  const [environment] = useState(createInboxStudioEnvironment);
  useEffect(() => {
    void environment.privacy.refresh();
    return () => {
      environment.stopBinding();
      environment.privacy.dispose();
      environment.runtime.dispose();
      environment.client.clear();
    };
  }, [environment]);

  return <div data-inbox-studio-selection-regression="" ref={node => {
    if (node) environments.set(node, environment);
  }}>
    <QueryClientProvider client={environment.client}>
      <MemoryRouter initialEntries={["/inbox"]}>
        <Shell privacy={environment.privacy} runtime={environment.runtime} fixture={false} />
      </MemoryRouter>
    </QueryClientProvider>
  </div>;
}

async function playInboxStudioSelectionRegression({ canvas, userEvent }: {
  readonly canvas: {
    findAllByRole(role: string, options: { readonly name: string | RegExp; readonly exact?: boolean }): Promise<HTMLElement[]>;
    findByText(text: string, options?: { readonly selector?: string }): Promise<HTMLElement>;
    queryByText(text: string, options?: { readonly selector?: string }): HTMLElement | null;
  };
  readonly userEvent: { click(element: HTMLElement): Promise<void> };
}) {
  const root = document.querySelector<HTMLElement>("[data-inbox-studio-selection-regression]");
  const environment = root ? environments.get(root) : undefined;
  if (!environment) throw new Error("Inbox/Studio composed runtime fixture is missing");

  const inboxButtons = await canvas.findAllByRole("button", { name: "Open in Studio", exact: true });
  if (inboxButtons.length !== 2 || !inboxButtons[1]) throw new Error("Expected two same-title Inbox proposal rows");
  const start = environment.requestEventCount();
  await userEvent.click(inboxButtons[1]);
  await canvas.findByText(secondBody, { selector: ".er-studio-live__body" });
  if (canvas.queryByText(firstBody, { selector: ".er-studio-live__body" })) {
    throw new Error("Inbox Open selected the first same-title proposal instead of the clicked second ref");
  }
  const opened = environment.requestEventsSince(start);
  const secondPath = `/api/v1/research/wiki/proposals/${secondId}`;
  const firstPath = `/api/v1/research/wiki/proposals/${firstId}`;
  if (!opened.some(event => event.method === "GET" && event.path === secondPath) ||
    opened.some(event => event.method !== "GET" || event.path.startsWith(firstPath)) ||
    environment.postCount() !== 0 || environment.mintedKeyCount() !== 0) {
    throw new Error("Opening the second same-title proposal did not use exact GET-only selection");
  }

  const inboxLinks = await canvas.findAllByRole("link", { name: "Inbox", exact: true });
  const inboxLink = inboxLinks.find(link => link.getAttribute("href") === "/inbox");
  if (!inboxLink) throw new Error("Inbox navigation link is missing");
  await userEvent.click(inboxLink);
  const firstOpenButtons = await canvas.findAllByRole("button", { name: "Open in Studio", exact: true });
  if (firstOpenButtons.length !== 2 || !firstOpenButtons[0]) throw new Error("Inbox proposal rows did not return");
  environment.seedUnknownIntent();
  const beforeBlockedOpen = environment.requestEventCount();
  await userEvent.click(firstOpenButtons[0]);
  await canvas.findByText(
    "The last action has no confirmed outcome. Its original draft, content and request identity are preserved.",
    { selector: ".er-status > span" },
  );
  await canvas.findByText(secondBody, { selector: ".er-studio-live__body" });
  const memory = environment.readStudioMemory();
  const selected = memory?.selected, intent = memory?.intent;
  const blockedOpenEvents = environment.requestEventsSince(beforeBlockedOpen);
  if (!selected || selected.id !== secondId || selected.revision !== 1 ||
    intent?.phase !== "unknown" || intent.key !== uncertainKey || intent.body !== "Preserve this body" ||
    intent.title !== "Owner-held edit" || intent.note !== "uncertain request" || intent.base.proposal_ref.id !== secondId ||
    environment.mintedKeyCount() !== 0 ||
    environment.postCount() !== 0 || blockedOpenEvents.some(event => event.method !== "GET" || event.path.startsWith(firstPath))) {
    throw new Error("Inbox Open replaced an unknown intent, read another proposal, minted a key or dispatched a mutation");
  }
}

export default {
  title: "Workspace/Inbox Studio selection regression",
  component: InboxStudioSelectionPreview,
  parameters: { layout: "fullscreen" },
};

export const InboxStudioSelectionRegression = {
  name: "Inbox Studio Selection Regression",
  render: () => <InboxStudioSelectionPreview />,
  play: playInboxStudioSelectionRegression,
};
