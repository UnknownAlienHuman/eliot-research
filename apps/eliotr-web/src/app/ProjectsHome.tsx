import { Button, MaterialSymbol, Status } from "@eliotr/ui";
import type { ProjectSummary } from "@eliotr/owner-api-client";
import "./projects-home.css";

const copy = {
  en: {
    lead: "Open a project to research its sources, read saved reports and use research tools.",
    heading: "Your projects", loading: "Reading projects.", error: "Projects could not be read.", retry: "Try again",
    empty: "No projects are available yet. Projects appear here once sources are organised into them.",
    open: "Opened", previous: "Previous page", next: "More projects",
    sources: (count: number) => count === 1 ? "1 source" : `${count} sources`,
  },
  ru: {
    lead: "Откройте проект, чтобы исследовать его источники, читать сохранённые отчёты и пользоваться инструментами.",
    heading: "Ваши проекты", loading: "Читаются проекты.", error: "Не удалось прочитать проекты.", retry: "Повторить",
    empty: "Пока нет доступных проектов. Они появятся здесь, когда источники будут распределены по проектам.",
    open: "Открыт", previous: "Предыдущая страница", next: "Ещё проекты",
    sources: (count: number) => {
      const tail = count % 10, hundred = count % 100;
      const word = tail === 1 && hundred !== 11 ? "источник" : tail >= 2 && tail <= 4 && (hundred < 12 || hundred > 14) ? "источника" : "источников";
      return `${count} ${word}`;
    },
  },
} as const;
const accents = ["blue", "violet", "pink", "green", "amber"] as const;

/** NotebookLM-style home: one card per project; opening a card hands its id to the workspace owner. */
export function ProjectsHome({ locale, state, projects, openedProjectId, onOpen, onRetry, onPrevious, onNext }: {
  readonly locale: "en" | "ru";
  readonly state: "loading" | "error" | "useful";
  readonly projects: readonly ProjectSummary[];
  readonly openedProjectId: string | undefined;
  readonly onOpen: (projectId: string) => void;
  readonly onRetry: () => void;
  readonly onPrevious?: (() => void) | undefined;
  readonly onNext?: (() => void) | undefined;
}) {
  const text = copy[locale];
  const created = (iso: string) => {
    const date = new Date(iso);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-GB", { day: "numeric", month: "short", year: "numeric" }).format(date) : "";
  };
  return <section className="er-projects-home" aria-labelledby="projects-home-heading">
    <p className="er-projects-home__lead">{text.lead}</p>
    <div className="er-projects-home__heading-row">
      <h2 id="projects-home-heading">{text.heading}</h2>
      {state === "useful" && projects.length > 0 ? <span className="er-projects-home__count">{projects.length}</span> : null}
    </div>
    {state === "loading" ? <Status>{text.loading}</Status> : null}
    {state === "error" ? <div className="er-projects-home__problem"><Status tone="error">{text.error}</Status><Button variant="tonal" onClick={onRetry}>{text.retry}</Button></div> : null}
    {state === "useful" && projects.length === 0 ? <p className="er-projects-home__empty">{text.empty}</p> : null}
    {projects.length > 0 ? <ul className="er-projects-home__grid">
      {projects.map((project, index) => {
        const opened = project.project_id === openedProjectId;
        return <li key={project.project_id}>
          <button type="button" className="er-projects-home__card" data-accent={accents[index % accents.length]}
            aria-current={opened ? "true" : undefined} onClick={() => onOpen(project.project_id)}>
            <span className="er-projects-home__glyph"><MaterialSymbol name="folder" /></span>
            <span className="er-projects-home__title">{project.title}</span>
            <span className="er-projects-home__meta">
              <span>{text.sources(project.source_ids.length)}</span>
              {created(project.created_at) ? <> · <time dateTime={project.created_at}>{created(project.created_at)}</time></> : null}
            </span>
            {opened ? <span className="er-projects-home__opened">{text.open}</span> : null}
          </button>
        </li>;
      })}
    </ul> : null}
    {onPrevious || onNext ? <div className="er-projects-home__pages">
      {onPrevious ? <Button variant="text" onClick={onPrevious}>{text.previous}</Button> : null}
      {onNext ? <Button variant="tonal" onClick={onNext}>{text.next}</Button> : null}
    </div> : null}
  </section>;
}
