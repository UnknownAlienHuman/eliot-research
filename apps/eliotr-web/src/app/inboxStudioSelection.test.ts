import { describe, expect, it } from "vitest";
import type { WikiProposalListView, WikiProposalReadView } from "@eliotr/owner-api-client";
import type { SessionContext } from "./privacy";
import type { InboxStudioSelection } from "./inboxStudioSelection";
import {
  createInboxStudioSelection,
  inboxProposalItemId,
  matchesInboxStudioReadback,
  resolveInboxStudioSelection,
} from "./inboxStudioSelection";

const context: SessionContext = {
  principal: "owner-a",
  credentialGeneration: "credential-3",
  deploymentGeneration: "deployment-7",
  cacheEpoch: 12,
  expiresAt: "2026-10-15T12:00:00.000Z",
};

function proposal(id: string, title: string): WikiProposalListView["items"][number] {
  return {
    proposal_ref: { id, revision: 1 }, page_ref: { id: `page-${id}`, revision: 1 }, title,
    page_type: "Topic", risk_class: "D2_ANALYTICAL", state: "PROPOSED", created_at: "2026-10-14T12:00:00.000Z",
  };
}

function proposalList(items: readonly WikiProposalListView["items"][number][]): WikiProposalListView {
  return { protocol: "eliotr.wiki-proposals.v1", items, has_more: false, deployment_generation: context.deploymentGeneration };
}

function request(value: WikiProposalListView["items"][number], owner = context): InboxStudioSelection {
  const selection = createInboxStudioSelection(value, owner);
  if (!selection) throw new Error("Test proposal must create a valid Inbox selection");
  return selection;
}

describe("Inbox to Studio proposal selection", () => {
  it("selects the exact ref when different proposals share a title and the list order changes", () => {
    const first = proposal("wiki:opaque:first", "Shared title");
    const second = proposal("wiki:opaque:second", "Shared title");
    const routeState = request(second);

    expect(inboxProposalItemId(0)).not.toContain(first.proposal_ref.id);
    expect(inboxProposalItemId(1)).not.toContain(second.proposal_ref.id);
    expect(resolveInboxStudioSelection(routeState, context, proposalList([second, first]))?.proposalRef)
      .toEqual(second.proposal_ref);
  });

  it("rejects route state from another owner or cache session", () => {
    const selected = proposal("proposal-a", "Draft A");
    const routeState = request(selected);
    const rows = proposalList([selected]);

    expect(resolveInboxStudioSelection(routeState, { ...context, principal: "owner-b" }, rows)).toBeUndefined();
    expect(resolveInboxStudioSelection(routeState, { ...context, cacheEpoch: context.cacheEpoch + 1 }, rows)).toBeUndefined();
  });

  it("leaves pending and unknown Studio intents untouched by refusing route selection", () => {
    const selected = proposal("proposal-a", "Draft A");
    const routeState = request(selected);
    const rows = proposalList([selected]);

    expect(resolveInboxStudioSelection(routeState, context, rows, { phase: "pending" })).toBeUndefined();
    expect(resolveInboxStudioSelection(routeState, context, rows, { phase: "unknown" })).toBeUndefined();
  });

  it("rejects mismatched title/ref and obsolete presentation cursor fields", () => {
    const selected = proposal("proposal-a", "Draft A");
    const other = proposal("proposal-b", "Draft B");
    const routeState = request(selected);
    const rows = proposalList([selected, other]);

    expect(resolveInboxStudioSelection({ ...routeState, proposalRef: other.proposal_ref }, context, rows)).toBeUndefined();
    expect(resolveInboxStudioSelection({ ...routeState, title: other.title }, context, rows)).toBeUndefined();
    expect(resolveInboxStudioSelection({ ...routeState, itemId: inboxProposalItemId(1) }, context, rows)).toBeUndefined();
  });

  it("rejects duplicate proposal refs even when their titles differ", () => {
    const selected = proposal("proposal-a", "Draft A");
    const duplicateRef = { ...selected, title: "Conflicting title" };

    expect(resolveInboxStudioSelection(request(selected), context, proposalList([selected, duplicateRef]))).toBeUndefined();
  });

  it("requires strict readback to preserve the requested ref, title, state and deployment", () => {
    const selected = proposal("proposal-a", "Draft A");
    const selection = resolveInboxStudioSelection(request(selected), context, proposalList([selected]));
    if (!selection) throw new Error("Test proposal must resolve from its current Inbox row");
    const readback = {
      proposal_ref: selected.proposal_ref, page: { title: selected.title }, state: "PROPOSED",
      deployment_generation: context.deploymentGeneration,
    } as unknown as WikiProposalReadView;

    expect(matchesInboxStudioReadback(selection, context, readback)).toBe(true);
    expect(matchesInboxStudioReadback(selection, context,
      { ...readback, page: { title: "Different title" } } as WikiProposalReadView)).toBe(false);
    expect(matchesInboxStudioReadback(selection, context,
      { ...readback, state: "PUBLISHED" } as WikiProposalReadView)).toBe(false);
  });
});
