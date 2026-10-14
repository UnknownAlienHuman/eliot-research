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
    lead: "Name your project. It will keep the sources selected for your next question.", sources: "Selected sources",
    empty: "Choose sources in Sources before creating this project.", invalid: "Review the project title and selected sources.",
    readback: "Check project status",
    phases: { idle: "", dispatching: "Creating the project.", reading: "Checking the project.",
      unconfirmed: "The outcome is unconfirmed. Check its status before creating another project.",
      refused: "Review the project details and try again.", "authorization-lost": "Your session ended. Sign in again to continue.",
      confirmed: "The project was confirmed." },
  },
  ru: {
    dialog: "Создать проект", close: "Вернуться к проектам", title: "Название проекта", create: "Создать проект",
    lead: "Назовите проект. Он сохранит источники, выбранные для следующего вопроса.", sources: "Выбранные источники",
    empty: "Перед созданием проекта выберите источники в разделе «Источники».", invalid: "Проверьте название проекта и выбранные источники.",
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
  const scopeReady = ids.length > 0 && ids.length === scope.length && ids.length <= PROJECT_MAX_SOURCE_IDS;
  const announcement = usePaneAnnouncement(text.phases[state.phase]);
  return <Dialog open={open} title={text.dialog} onClose={() => { if (!busy) onClose(); }}>
    <OperationAnnouncement>{announcement}</OperationAnnouncement>
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
      {!scopeReady && <Status>{text.empty}</Status>}
      {state.invalid !== undefined && <Status tone="error">{text.invalid}</Status>}
      <Button type="submit" variant="primary" loading={busy}
        disabled={!editable || !scopeReady || !state.title.trim() || !privacy.isCurrent(context)}>{text.create}</Button>
    </form>
    {state.phase === "unconfirmed" && <div className="er-live-actions">
      <Status>{text.phases.unconfirmed}</Status>
      <Button variant="tonal" onClick={() => { void controller.readStatus(new AbortController().signal); }}>{text.readback}</Button>
    </div>}
    {state.phase === "confirmed" && <Status>{text.phases.confirmed}</Status>}
    <Button variant="text" disabled={busy} onClick={onClose}>{text.close}</Button>
  </Dialog>;
}
