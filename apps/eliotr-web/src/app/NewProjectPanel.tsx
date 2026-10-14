import { useEffect, useId, useRef, useState } from "react";
import { Button, Dialog, Field, MaterialSymbol, OperationAnnouncement, Status } from "@eliotr/ui";
import type { ProjectSummary } from "@eliotr/owner-api-client";
import type { BoundWorkspaceApis } from "./runtime";
import type { PrivacyController, SessionContext } from "./privacy";
import { createProjectCreationController, PROJECT_MAX_SOURCE_IDS, type ProjectCreationCurrentPage, type ProjectCreationState } from "../query/projectCreation";
import { usePaneAnnouncement } from "./usePaneAnnouncement";

export interface NewProjectSource { readonly id: string; readonly label: string }
export interface NewProjectPanelProps {
  readonly locale: "en" | "ru";
  readonly apis: BoundWorkspaceApis;
  readonly privacy: PrivacyController;
  readonly context: SessionContext;
  readonly scope: readonly NewProjectSource[];
  readonly currentPage?: ProjectCreationCurrentPage;
  readonly onProjectCommitted?: (project: ProjectSummary) => void;
  readonly open: boolean;
  readonly onClose: () => void;
}

const copy = {
  en: {
    dialog: "Create a project", close: "Back to projects", title: "Project title", create: "Create project",
    lead: "Name your project. Selected sources stay with it; you can add sources later.", sources: "Selected sources",
    empty: "No sources selected. You can add sources to this project later.", recover: "Recover original request",
    invalid: "Review the project title and selected sources.",
    readback: "Check project status",
    phases: { idle: "", dispatching: "Creating the project.", reading: "Checking the project.",
      unconfirmed: "The outcome is unconfirmed. Check its status before creating another project.",
      refused: "Review the project details and try again.", "authorization-lost": "Your session ended. Sign in again to continue.",
      confirmed: "The project was confirmed." },
  },
  ru: {
    dialog: "Создать проект", close: "Вернуться к проектам", title: "Название проекта", create: "Создать проект",
    lead: "Назовите проект. Выбранные источники останутся в проекте; новые можно добавить позже.", sources: "Выбранные источники",
    empty: "Источники не выбраны. Их можно добавить в проект позже.", recover: "Восстановить исходный запрос",
    invalid: "Проверьте название проекта и выбранные источники.",
    readback: "Проверить состояние проекта",
    phases: { idle: "", dispatching: "Создаём проект.", reading: "Проверяем проект.",
      unconfirmed: "Исход не подтверждён. Проверьте его перед созданием другого проекта.",
      refused: "Проверьте данные проекта и повторите.", "authorization-lost": "Сеанс завершён. Войдите снова для продолжения.",
      confirmed: "Создание проекта подтверждено." },
  },
} as const;

/** The explicit submit gesture prepares one identity; only matching canonical readback reports a commit. */
export function NewProjectPanel(props: NewProjectPanelProps) {
  const { locale, apis, privacy, context, scope, open, onClose } = props;
  const latest = useRef(props);
  latest.current = props;
  const owned = useRef<{ context: SessionContext; controller: ReturnType<typeof createProjectCreationController> } | undefined>(undefined);
  if (owned.current?.context !== context) {
    owned.current = { context, controller: createProjectCreationController(apis.sources, privacy, context, {
      currentPage: () => latest.current.currentPage?.(),
      onProjectCommitted: project => latest.current.onProjectCommitted?.(project),
    }) };
  }
  const controller = owned.current.controller;
  const [observed, setObserved] = useState<{ controller: typeof controller; state: ProjectCreationState }>();
  const state = observed?.controller === controller ? observed.state : controller.getState();
  useEffect(() => controller.subscribe(() => setObserved({ controller, state: controller.getState() })), [controller]);
  useEffect(() => { if (!open) controller.dismiss(); }, [open, controller]);
  const text = copy[locale];
  const titleId = useId();
  const busy = state.phase === "dispatching" || state.phase === "reading";
  const editable = state.phase === "idle" || state.phase === "refused";
  const ids = [...new Set(scope.map(source => source.id))].sort();
  const scopeReady = ids.length === scope.length && ids.length <= PROJECT_MAX_SOURCE_IDS;
  const scopeEmpty = ids.length === 0;
  const announcement = usePaneAnnouncement(text.phases[state.phase]);
  return <Dialog open={open} title={text.dialog} onClose={() => { if (!busy) onClose(); }}>
    {/* A closed dialog owns no live region: the pane it sat in must expose exactly one operation channel, so a
        retained dialog may not keep a second region mounted. The announcement is ephemeral presentation state and
        the controller's identity and unconfirmed state survive the close unchanged. */}
    {open && <OperationAnnouncement>{announcement}</OperationAnnouncement>}
    <p>{text.lead}</p>
    <form className="er-live-import-settings" onSubmit={event => {
      event.preventDefault();
      if (!editable || !scopeReady || !privacy.isCurrent(context)) return;
      controller.setSourceIds(ids);
      if (controller.getState().key === undefined) controller.mintKey();
      void controller.submit(new AbortController().signal);
    }}>
      <Field id={titleId} label={text.title} value={state.title} required maxLength={4096} disabled={!editable}
        onChange={event => { controller.setTitle(event.target.value); }} />
      <p className="er-field__label">{text.sources}</p>
      <ul className="er-live-source-pick">{scope.map(source => <li key={source.id}>
        <MaterialSymbol name="file" /><span>{source.label}</span>
      </li>)}</ul>
      {scopeEmpty && <Status>{text.empty}</Status>}
      {state.invalid !== undefined && <Status tone="error">{text.invalid}</Status>}
      <Button type="submit" variant="primary" loading={busy}
        disabled={!editable || !scopeReady || !state.title.trim() || !privacy.isCurrent(context)}>{text.create}</Button>
    </form>
    {state.phase === "unconfirmed" && <div className="er-live-actions">
      <Status>{text.phases.unconfirmed}</Status>
      <Button variant="tonal" onClick={() => {
        const signal = new AbortController().signal;
        if (state.receipt?.project === undefined) void controller.recoverOriginalIntent(signal);
        else void controller.readStatus(signal);
      }}>{state.receipt?.project === undefined ? text.recover : text.readback}</Button>
    </div>}
    {state.phase === "confirmed" && <Status>{text.phases.confirmed}</Status>}
    <Button variant="text" disabled={busy} onClick={onClose}>{text.close}</Button>
  </Dialog>;
}
