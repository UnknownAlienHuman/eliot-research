import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Button, DecisionInbox, OperationAnnouncement, Status, type DecisionItem, type DecisionRisk } from "@eliotr/ui";
import type { WikiProposalListView } from "@eliotr/owner-api-client";
import type { BoundWorkspaceApis } from "./runtime";
import type { PrivacyController, SessionContext } from "./privacy";
import { studioQueryOptions } from "../query/studio";
import { usePaneAnnouncement } from "./usePaneAnnouncement";
import { createInboxStudioSelection, inboxProposalItemId } from "./inboxStudioSelection";

const copy = {
  en: {
    lead: "Agents propose and you decide. Low-risk edits apply by project policy; analysis, deletion and permissions wait for you here.",
    loading: "Reading proposals.", loaded: "Proposals loaded.", error: "Proposals could not be read.", retry: "Try again",
    open: "Open in Studio", wiki: "Wiki page",
  },
  ru: {
    lead: "Агенты предлагают, решаете вы. Безопасные правки применяются по правилам проекта; анализ, удаление и права ждут вас здесь.",
    loading: "Читаются предложения.", loaded: "Предложения прочитаны.", error: "Не удалось прочитать предложения.", retry: "Повторить",
    open: "Открыть в Студии", wiki: "Страница вики",
  },
} as const;

const RISK: Record<WikiProposalListView["items"][number]["risk_class"], DecisionRisk> = {
  D0_MECHANICAL: "D0", D1_LOW_RISK_ADDITIVE: "D1", D2_ANALYTICAL: "D2", D3_AUTHORITY_SENSITIVE: "D3",
};

/**
 * The owner's Inbox: Wiki proposals still waiting for a decision, owner-only work first. It reads the
 * same proposal list as Studio (one query key, no new request shape) and decides nothing itself —
 * publishing keeps its guarded flow in Studio until decision mutations exist for this surface.
 */
export function InboxPanel({ locale, apis, privacy, context }: {
  readonly locale: "en" | "ru"; readonly apis: BoundWorkspaceApis; readonly privacy: PrivacyController; readonly context: SessionContext;
}) {
  const text = copy[locale];
  const navigate = useNavigate();
  const client = useQueryClient();
  const proposalsQuery = studioQueryOptions(apis.studio, privacy, context, () => undefined).proposals();
  const proposals = useQuery(proposalsQuery);
  const announcement = usePaneAnnouncement(proposals.isFetching ? text.loading : proposals.isError ? text.error : proposals.data ? text.loaded : "");
  const date = (iso: string) => {
    const value = new Date(iso);
    return Number.isFinite(value.getTime()) ? new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-GB", { day: "numeric", month: "short", year: "numeric" }).format(value) : "";
  };
  const proposalByItemId = new Map<string, WikiProposalListView["items"][number]>();
  const items: readonly DecisionItem[] = (proposals.isError ? [] : proposals.data?.items ?? [])
    .filter(item => item.state === "PROPOSED")
    .flatMap((item, index) => {
      const id = inboxProposalItemId(index);
      if (!id || proposalByItemId.has(id)) return [];
      proposalByItemId.set(id, item);
      return [{ id, kind: "wiki" as const, risk: RISK[item.risk_class], title: item.title,
        detail: [text.wiki, date(item.created_at)].filter(Boolean).join(" · ") }];
    });
  return <>
    <OperationAnnouncement>{announcement}</OperationAnnouncement>
    <p className="er-shell-lead">{text.lead}</p>
    {proposals.isPending ? <Status>{text.loading}</Status> : null}
    {proposals.isError ? <div className="er-live-callout"><Status tone="error">{text.error}</Status>
      <Button variant="tonal" disabled={proposals.isFetching} onClick={() => { void proposals.refetch(); }}>{text.retry}</Button></div> : null}
    {proposals.isSuccess ? <DecisionInbox locale={locale} items={items} openLabel={text.open}
      onOpen={itemId => {
        const proposal = proposalByItemId.get(itemId), snapshot = proposals.data;
        if (!proposal || !snapshot || proposal.state !== "PROPOSED" || !privacy.isCurrent(context) ||
          client.getQueryData(proposalsQuery.queryKey) !== snapshot || !snapshot.items.includes(proposal)) return;
        const selection = createInboxStudioSelection(proposal, context);
        if (selection) void navigate("/studio", { state: selection, preventScrollReset: true });
      }} /> : null}
  </>;
}

/** The Inbox count for navigation. Reads only what the proposal list already holds, never fetching. */
export function InboxCount({ apis, privacy, context }: {
  readonly apis: BoundWorkspaceApis; readonly privacy: PrivacyController; readonly context: SessionContext;
}) {
  const proposals = useQuery({ ...studioQueryOptions(apis.studio, privacy, context, () => undefined).proposals(), enabled: false });
  const count = proposals.data?.items.filter(item => item.state === "PROPOSED").length ?? 0;
  return count > 0 ? <span className="er-shell-badge">{count > 99 ? "99+" : count}</span> : null;
}
