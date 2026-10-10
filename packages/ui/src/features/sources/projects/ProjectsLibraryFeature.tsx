// U3-P Projects Library feature surface. Presentation and local selection only.
// Server state arrives as props from the app's query layer; this component never fetches,
// never instantiates a factory or transport, and never derives readiness from a revision.
import { useId, type ReactNode, type Ref } from "react";
import { Button, IconButton, Status } from "../../../primitives/primitives";
import type { LibraryPage, LibraryReadinessView, SourceRevisionPage, ProjectListView } from "@eliotr/owner-api-client";
import {
  selectProjectRow,
  toReadinessRow,
  toRevisionRows,
  toSourceRows,
  type ProjectsLibraryPanelState,
  type ProjectsLibraryState,
  type ReadinessPresentation,
} from "./controller";
import "./projects-library.css";

export interface ProjectsLibraryFeatureProps {
  readonly locale: "en" | "ru";
  readonly state: ProjectsLibraryState;
  readonly projects: ProjectListView["projects"];
  readonly selectedProjectId: string | undefined;
  readonly onSelectProject: (projectId: string) => void;
  readonly projectSelectRef?: Ref<HTMLSelectElement>;
  readonly sourceActions?: ReactNode;
  readonly library: LibraryPage | undefined;
  readonly readiness: LibraryReadinessView | undefined;
  readonly readinessState: ProjectsLibraryPanelState;
  readonly revisions: SourceRevisionPage | undefined;
  readonly revisionsState: ProjectsLibraryPanelState;
  readonly selectedSourceId: string | undefined;
  readonly onOpenSource: (sourceId: string) => void;
  readonly onLoadRevisions: (sourceId: string) => void;
  readonly onRetry: () => void;
  readonly onReadRevision?: (sourceRevisionRef: string) => void;
}

type Copy = {
  readonly scope: string;
  readonly projectLabel: string;
  readonly projectChoose: string;
  readonly projectEmpty: string;
  readonly sourcesLabel: string;
  readonly recordedOnly: string;
  readonly readinessHeading: string;
  readonly checked: string;
  readonly version: string;
  readonly read: string;
  readonly quality: Readonly<Record<LibraryReadinessView["quality_state"], string>>;
  readonly unverified: string;
  readonly qualityLabel: string;
  readonly exact: string;
  readonly lexical: string;
  readonly semantic: string;
  readonly revisionLabel: string;
  readonly revisionRef: string;
  readonly technicalDetails: string;
  readonly readinessRefLabel: string;
  readonly sourceIdLabel: string;
  readonly revisionContent: string;
  readonly revisionCaptured: string;
  readonly revisionAdmitted: string;
  readonly ready: string;
  readonly partial: string;
  readonly unavailable: string;
  readonly unknown: string;
  readonly openSource: string;
  readonly revisionsAction: string;
  readonly loading: string;
  readonly empty: string;
  readonly degraded: string;
  readonly error: string;
  readonly retry: string;
};

const COPY: Readonly<Record<"en" | "ru", Copy>> = {
  en: {
    scope: "Versions preserve saved content. Search readiness is checked separately.",
    projectLabel: "Project",
    projectChoose: "Choose a project",
    projectEmpty: "No projects are available yet.",
    sourcesLabel: "Project sources",
    recordedOnly: "Saved versions do not establish current search readiness.",
    readinessHeading: "Search readiness",
    checked: "Currentness verified",
    version: "Saved version",
    read: "Read version",
    quality: { high_fidelity: "High fidelity", standard: "Standard", degraded: "Degraded", unqualified: "Unqualified" },
    unverified: "Currentness was not verified.",
    qualityLabel: "Quality",
    exact: "Exact",
    lexical: "Lexical",
    semantic: "Semantic",
    revisionLabel: "Saved versions",
    revisionRef: "Revision",
    technicalDetails: "Technical details",
    readinessRefLabel: "Readiness reference",
    sourceIdLabel: "Source",
    revisionContent: "Content digest",
    revisionCaptured: "Captured",
    revisionAdmitted: "Admitted",
    ready: "Ready",
    partial: "Partly ready",
    unavailable: "Unavailable",
    unknown: "Unknown",
    openSource: "Open",
    revisionsAction: "Versions",
    loading: "Loading project sources...",
    empty: "No sources in this project.",
    degraded: "Readiness is temporarily unavailable. You can still choose a project.",
    error: "Sources could not be loaded.",
    retry: "Try again",
  },
  ru: {
    scope: "Версии сохраняют содержимое. Готовность к поиску проверяется отдельно.",
    projectLabel: "Проект",
    projectChoose: "Выберите проект",
    projectEmpty: "Пока нет доступных проектов.",
    sourcesLabel: "Источники проекта",
    recordedOnly: "Сохранённые версии не подтверждают текущую готовность к поиску.",
    readinessHeading: "Готовность к поиску",
    checked: "Актуальность проверена",
    version: "Сохранённая версия",
    read: "Читать версию",
    quality: { high_fidelity: "Высокая точность", standard: "Стандартное", degraded: "Сниженное", unqualified: "Не проверено" },
    unverified: "Актуальность не проверена.",
    qualityLabel: "Качество",
    exact: "Точный",
    lexical: "Лексический",
    semantic: "Семантический",
    revisionLabel: "Сохранённые версии",
    revisionRef: "Ревизия",
    technicalDetails: "Технические сведения",
    readinessRefLabel: "Ссылка на готовность",
    sourceIdLabel: "Источник",
    revisionContent: "Дайджест содержимого",
    revisionCaptured: "Захвачено",
    revisionAdmitted: "Допущено",
    ready: "Готов",
    partial: "Частично готов",
    unavailable: "Недоступно",
    unknown: "Неизвестно",
    openSource: "Открыть",
    revisionsAction: "Версии",
    loading: "Загрузка источников проекта...",
    empty: "В этом проекте нет источников.",
    degraded: "Готовность временно недоступна. Можно выбрать другой проект.",
    error: "Не удалось загрузить источники.",
    retry: "Повторить",
  },
};

const CHANNEL_LABEL: Readonly<Record<ReadinessPresentation, "ready" | "partial" | "unavailable" | "unknown">> = {
  ready: "ready",
  partial: "partial",
  unavailable: "unavailable",
  unknown: "unknown",
};

function panelStatus(
  state: ProjectsLibraryPanelState | ProjectsLibraryState,
  copy: Copy,
): readonly [string, "neutral" | "error"] | undefined {
  if (state === "loading") return [copy.loading, "neutral"];
  if (state === "degraded") return [copy.degraded, "neutral"];
  if (state === "error") return [copy.error, "error"];
  return undefined;
}

export function ProjectsLibraryFeature(props: ProjectsLibraryFeatureProps) {
  const projectSelectId = useId();
  const sourcesHeadingId = `${projectSelectId}-sources`;
  const copy = COPY[props.locale];
  const selected = selectProjectRow(props.projects, props.selectedProjectId);
  const rows = toSourceRows(props.library);
  const readiness = toReadinessRow(props.readiness);
  const revisionRows = toRevisionRows(props.revisions);
  const status = panelStatus(props.state, copy);
  const readinessStatus = panelStatus(props.readinessState, copy);
  const revisionsStatus = panelStatus(props.revisionsState, copy);
  const settled = props.state === "useful" || props.state === "empty";
  const showProjectEmpty = settled && props.projects.length === 0;
  const showProjectPrompt = settled && props.projects.length > 0 && selected === undefined && props.library === undefined;
  const showSourceEmpty = settled && selected !== undefined && props.library !== undefined && rows.length === 0;

  const channelText = (presentation: ReadinessPresentation): string => {
    const key = CHANNEL_LABEL[presentation];
    if (key === "ready") return copy.ready;
    if (key === "partial") return copy.partial;
    if (key === "unavailable") return copy.unavailable;
    return copy.unknown;
  };

  const quality = copy.quality[readiness?.qualityState ?? "unqualified"];
  const selectedSource = rows.find(row => row.sourceId === props.selectedSourceId);
  const versionDate = (iso: string): string => {
    const date = new Date(iso);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(props.locale === "ru" ? "ru-RU" : "en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date) : copy.unknown;
  };

  return (
    <section className="er-projects-library" aria-labelledby={sourcesHeadingId} aria-busy={props.state === "loading"}>
      {props.projects.length === 0 ? (
        showProjectEmpty ? <p className="er-projects-library__project-empty">{copy.projectEmpty}</p> : null
      ) : (
        <div className="er-projects-library__project-context">
          <label className="er-projects-library__project-label" htmlFor={projectSelectId}>
            {copy.projectLabel}
          </label>
          <select
            className="er-projects-library__project-select"
            id={projectSelectId}
            ref={props.projectSelectRef}
            value={selected?.projectId ?? ""}
            onChange={event => {
              const projectId = event.currentTarget.value;
              if (projectId !== selected?.projectId && props.projects.some(project => project.project_id === projectId)) {
                props.onSelectProject(projectId);
              }
            }}
          >
            <option value="" disabled>{copy.projectChoose}</option>
            {props.projects.map(project => (
              <option key={project.project_id} value={project.project_id}>{project.title}</option>
            ))}
          </select>
        </div>
      )}
      {props.sourceActions}

      {status === undefined ? null : <Status tone={status[1]}>{status[0]}</Status>}

      <div className="er-projects-library__body">
        <h2 id={sourcesHeadingId} className="er-projects-library__subheading">{copy.sourcesLabel}</h2>
        {showProjectPrompt ? <Status>{copy.projectChoose}</Status> : null}
        {showSourceEmpty ? <Status>{copy.empty}</Status> : null}
        <ul className="er-projects-library__sources" aria-labelledby={sourcesHeadingId}>
          {rows.map(row => (
            <li key={row.sourceId} className="er-projects-library__source" data-selected={row.sourceId === props.selectedSourceId}>
              <div className="er-projects-library__source-head">
                <h3 className="er-projects-library__source-title">
                  <Button variant="text" aria-pressed={row.sourceId === props.selectedSourceId} onClick={() => props.onOpenSource(row.sourceId)}>
                    {row.title}
                  </Button>
                </h3>
                <IconButton
                  label={`${copy.revisionsAction}: ${row.title}`}
                  icon="chevron"
                  onClick={() => props.onLoadRevisions(row.sourceId)}
                />
              </div>
              <details className={"er-projects-library__facts"}>
                <summary>{copy.technicalDetails}</summary>
                <dl>
                  <dt>{copy.readinessRefLabel}</dt>
                  <dd>{row.readinessRef}</dd>
                  <dt>{copy.sourceIdLabel}</dt>
                  <dd>{row.sourceId}</dd>
                </dl>
              </details>
            </li>
          ))}
        </ul>
      </div>

      <div className="er-projects-library__panels">
        <section className="er-projects-library__panel" aria-label={copy.readinessHeading}>
          <h3 className="er-projects-library__panel-heading">{copy.readinessHeading}</h3>
          {selectedSource && <p className="er-projects-library__hint">{selectedSource.title}</p>}
          {props.readinessState === "idle" || readiness === undefined ? null : (
            <dl className="er-projects-library__readiness">
              <dt>{copy.qualityLabel}</dt>
              <dd>{quality ?? copy.unknown}</dd>
              <dt>{copy.exact}</dt>
              <dd data-state={CHANNEL_LABEL[readiness.exact]}>{channelText(readiness.exact)}</dd>
              <dt>{copy.lexical}</dt>
              <dd data-state={CHANNEL_LABEL[readiness.lexical]}>{channelText(readiness.lexical)}</dd>
              <dt>{copy.semantic}</dt>
              <dd data-state={CHANNEL_LABEL[readiness.semantic]}>{channelText(readiness.semantic)}</dd>
            </dl>
          )}
          {readiness && <p className="er-projects-library__hint">{readiness.currentnessVerified ? copy.checked : copy.unverified}</p>}
          {readinessStatus === undefined ? null : (
            <Status tone={readinessStatus[1]}>{readinessStatus[0]}</Status>
          )}
        </section>

        <section className="er-projects-library__panel">
          <h3 className="er-projects-library__panel-heading">{copy.revisionLabel}</h3>
          {revisionRows.length === 0 ? null : (
            <ul className="er-projects-library__revisions">
              {revisionRows.map((row, index) => (
                <li key={row.sourceRevisionRef} className="er-projects-library__revision">
                  <div className="er-projects-library__version-head">
                    <p className="er-projects-library__version-title">{copy.version} · <time dateTime={row.admittedAt}>{versionDate(row.admittedAt)}</time></p>
                    {props.onReadRevision && <Button variant="tonal" aria-label={`${copy.read} ${index + 1}`} onClick={() => props.onReadRevision?.(row.sourceRevisionRef)}>{copy.read}</Button>}
                  </div>
                  <details className="er-projects-library__facts">
                    <summary>{copy.technicalDetails}</summary>
                    <dl>
                      <dt>{copy.revisionRef}</dt><dd>{row.sourceRevisionRef}</dd>
                      <dt>{copy.revisionContent}</dt><dd>{row.contentSha256}</dd>
                      <dt>{copy.revisionCaptured}</dt><dd>{row.capturedAt}</dd>
                      <dt>{copy.revisionAdmitted}</dt><dd>{row.admittedAt}</dd>
                    </dl>
                  </details>
                </li>
              ))}
            </ul>
          )}
          {revisionsStatus === undefined ? null : (
            <Status tone={revisionsStatus[1]}>{revisionsStatus[0]}</Status>
          )}
        </section>
      </div>

      {props.state === "error" ? (
        <div className="er-projects-library__actions">
          <Button variant="text" onClick={props.onRetry}>
            {copy.retry}
          </Button>
        </div>
      ) : null}
      <p className="er-projects-library__note">{copy.scope}</p>
    </section>
  );
}
