import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import type { PrivacyController, SessionContext } from "./privacy";
import { protectedQueryKey } from "../query/client";
import "./workspace-notifications.css";

interface NoticeAction { readonly label: string; readonly run: () => void }
interface Notice { readonly message: string; readonly action?: NoticeAction; readonly sticky?: boolean }

/** A newer Eliot was deployed while this page was open: every protected read now fails closed. */
function isDeploymentChange(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
  return typeof code === "string" && (code === "API_GENERATION_MISMATCH" || code.endsWith("_DEPLOYMENT_CHANGED") ||
    code === "CATALOG_GENERATION_CHANGED" || code === "PROJECT_GENERATION_MISMATCH");
}

/** Background reads that already explain themselves where they are shown; a pop-up would only repeat them vaguely. */
const QUIET = new Set(["service-model-settings", "service-model-catalog", "research-method-readiness", "project-guide",
  "ai-usage", "computer-agent-dispatches"]);

/** Names what failed, in the owner's words, so a notice always says which part of the workspace it is about. */
function failedRead(resource: unknown, ru: boolean): string {
  switch (resource) {
    case "sources": return ru ? "Не удалось обновить источники." : "Sources could not be refreshed.";
    case "imports": return ru ? "Не удалось обновить ход загрузки." : "Upload progress could not be refreshed.";
    case "research": return ru ? "Не удалось обновить ход исследования." : "Research progress could not be refreshed.";
    case "report": case "reports": case "artifact-actions":
      return ru ? "Не удалось открыть отчёт." : "The report could not be opened.";
    case "projects": return ru ? "Не удалось загрузить проекты." : "Projects could not be loaded.";
    case "studio": return ru ? "Не удалось загрузить Студию." : "Studio could not be loaded.";
    case "erasure": return ru ? "Не удалось проверить удаление." : "Deletion status could not be checked.";
    case "connections": return ru ? "Не удалось проверить подключения." : "Connections could not be checked.";
    default:
      return typeof resource === "string" && resource.startsWith("computer-agent")
        ? ru ? "Не удалось обновить состояние агента." : "Agent status could not be refreshed."
        : ru ? "Не удалось обновить данные на этой странице." : "This page could not be refreshed.";
  }
}
type Notify = (message: string, action?: NoticeAction) => void;
const NoticeContext = createContext<Notify>(() => {});
export function useWorkspaceNotice(): Notify { return useContext(NoticeContext); }

/** Ephemeral notices. Retry actions here are canonical GET reads, never mutation replays. */
export function WorkspaceNotifications({ children, locale, privacy, context }: {
  readonly children: ReactNode; readonly locale: "en" | "ru";
  readonly privacy: PrivacyController; readonly context: SessionContext;
}) {
  const client = useQueryClient(), navigate = useNavigate();
  const [notice, setNotice] = useState<Notice>();
  const seen = useRef(new Map<string, string>());
  const notify: Notify = useCallback((message, action) => {
    if (privacy.isCurrent(context)) setNotice({ message, ...(action ? { action } : {}) });
  }, [context, privacy]);
  useEffect(() => {
    const prefix = protectedQueryKey(context, "").slice(0, -1);
    return client.getQueryCache().subscribe(event => {
      if (event.type !== "updated" || !privacy.isCurrent(context) ||
          !prefix.every((part, index) => event.query.queryKey[index] === part)) return;
      const query = event.query;
      if (event.action.type === "error") {
        const resource = query.queryKey[prefix.length], ru = locale === "ru";
        if (isDeploymentChange(event.action.error)) {
          setNotice({ sticky: true, message: ru ? "Eliot обновился. Перезагрузите страницу, чтобы продолжить."
            : "Eliot was updated. Reload the page to continue.", action: { label: ru ? "Перезагрузить" : "Reload",
            run: () => { window.location.reload(); } } });
          return;
        }
        if (QUIET.has(String(resource))) return;
        setNotice(old => old?.sticky ? old : { message: failedRead(resource, ru), action: { label: ru ? "Повторить" : "Try again", run: () => {
          if (privacy.isCurrent(context)) void client.refetchQueries({ queryKey: query.queryKey, exact: true });
        } } });
        return;
      }
      if (event.action.type !== "success") return;
      const data: unknown = query.state.data;
      if (data === null || typeof data !== "object" || !("engine_status" in data)) return;
      const outcome = data.engine_status;
      if (typeof outcome !== "string" || !["complete", "errored", "terminated"].includes(outcome) ||
          seen.current.get(query.queryHash) === outcome) return;
      seen.current.set(query.queryHash, outcome);
      const message = outcome === "complete"
        ? locale === "ru" ? "Исследование завершено." : "Research completed."
        : locale === "ru" ? "Исследование остановлено. Откройте его состояние." : "Research stopped. Open its status.";
      setNotice(old => old?.sticky ? old : { message, action: { label: locale === "ru" ? "Открыть" : "Open", run: () => {
        if (privacy.isCurrent(context)) void navigate("/research");
      } } });
    });
  }, [client, context, locale, navigate, privacy]);
  useEffect(() => {
    if (!notice || notice.sticky) return;
    const timer = window.setTimeout(() => setNotice(undefined), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  return <NoticeContext.Provider value={notify}>{children}
    {notice && privacy.isCurrent(context) && <div className="er-workspace-snackbar" role="status" aria-live="polite">
      <span>{notice.message}</span>
      {notice.action && <button type="button" onClick={() => { notice.action?.run(); setNotice(undefined); }}>{notice.action.label}</button>}
      <button type="button" aria-label={locale === "ru" ? "Закрыть уведомление" : "Dismiss notification"}
        onClick={() => setNotice(undefined)}>×</button>
    </div>}
  </NoticeContext.Provider>;
}
