import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import type { PrivacyController, SessionContext } from "./privacy";
import { protectedQueryKey } from "../query/client";
import "./workspace-notifications.css";

interface NoticeAction { readonly label: string; readonly run: () => void }
interface Notice { readonly message: string; readonly action?: NoticeAction }
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
        const resource = query.queryKey[prefix.length];
        const message = resource === "sources"
          ? locale === "ru" ? "Не удалось обновить источники." : "Sources could not be refreshed."
          : locale === "ru" ? "Не удалось прочитать актуальное состояние." : "The current status could not be read.";
        setNotice({ message, action: { label: locale === "ru" ? "Повторить" : "Try again", run: () => {
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
      setNotice({ message, action: { label: locale === "ru" ? "Открыть" : "Open", run: () => {
        if (privacy.isCurrent(context)) void navigate("/research");
      } } });
    });
  }, [client, context, locale, navigate, privacy]);
  useEffect(() => {
    if (!notice) return;
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
