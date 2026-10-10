import { useLayoutEffect, useState, type RefObject } from "react";
import { useLocation, useNavigate } from "react-router";
import { WorkspaceLink } from "../routes/WorkspaceLink";
import { Button, Dialog } from "@eliotr/ui";
import { SourcesFixture } from "../../../../packages/ui/src/patterns/sources/fixtures/SourcesFixture";
import { ResearchFixture } from "../../../../packages/ui/src/patterns/research/fixtures/ResearchFixture";
import { StudioFixture } from "../../../../packages/ui/src/patterns/studio/fixtures/StudioFixture";
import { ConnectionsFixture } from "../../../../packages/ui/src/patterns/connections/fixtures/ConnectionsFixture";
import type { destinations } from "../routes/location";
import "./fixture-workspace.css";

type Destination = typeof destinations[number];
type Locale = "en" | "ru";
const copy = {
  en: {
    project: "Project", knowledge: "Evidence in everyday research", design: "Designing a clear knowledge workspace",
    sources: "Sources", research: "Research", studio: "Studio", connections: "Connections",
    nextScope: "For your next question", choose: "Choose sources", original: "The sample report keeps its original source scope.",
    selected: (count: number) => `${count} ${count === 1 ? "source selected" : "sources selected"}`,
    frozen: (count: number) => `Original sample report: ${count} ${count === 1 ? "source" : "sources"}`,
    evidence: "Evidence", passage: "Clarity starts with a clear relationship between the question, the source, and the claim.",
    context: "Synthetic passage · original sample revision. Native page coordinates are unavailable.",
    citationState: "Sample excerpt · current verification unknown", back: "Back to report", sourceContext: "View sample source context",
    sample: "All actions in this preview use local sample data.",
    report: "An explicit source scope keeps a claim connected to the material that informed it. Review the original passage, keep uncertainty visible, and distinguish a saved draft from an accepted report.",
  },
  ru: {
    project: "Проект", knowledge: "Доказательства в повседневной исследовательской работе", design: "Проектирование понятного рабочего пространства знаний",
    sources: "Источники", research: "Исследование", studio: "Студия", connections: "Подключения",
    nextScope: "Для следующего вопроса", choose: "Выбрать источники", original: "Образец отчёта сохраняет первоначальный набор источников.",
    selected: (count: number) => `Выбрано источников: ${count}`,
    frozen: (count: number) => `Первоначальный набор образца отчёта: ${count}`,
    evidence: "Доказательство", passage: "Ясность начинается с понятной связи между вопросом, источником и утверждением.",
    context: "Учебный фрагмент · исходная версия образца. Координаты страниц оригинала недоступны.",
    citationState: "Учебный фрагмент · текущая проверка неизвестна", back: "Вернуться к отчёту", sourceContext: "Открыть учебный контекст источника",
    sample: "Все действия в этом макете используют локальные учебные данные.",
    report: "Явный набор источников сохраняет связь утверждения с материалами, на которых оно основано. Проверяйте первоначальный фрагмент, показывайте неопределённость и отличайте сохранённый черновик от принятого отчёта.",
  },
} as const;

export function FixtureWorkspace({ destination, locale, headingRef }: {
  readonly destination: Destination;
  readonly locale: Locale;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const [project, setProject] = useState("knowledge");
  const text = copy[locale];
  return <LocalProject key={project} destination={destination} locale={locale} headingRef={headingRef}
    project={project} onProject={setProject} projectTitle={project === "knowledge" ? text.knowledge : text.design} />;
}

function LocalProject({ destination, locale, headingRef, project, projectTitle, onProject }: {
  readonly destination: Destination;
  readonly locale: Locale;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly project: string;
  readonly projectTitle: string;
  readonly onProject: (project: string) => void;
}) {
  const text = copy[locale];
  const [selection, setSelection] = useState<readonly string[]>(["notes-4", "datasheets"]);
  const [reportScope] = useState<readonly string[]>(["notes-4", "datasheets"]);
  const location = useLocation();
  const navigate = useNavigate();
  const state: unknown = location.state;
  const localContext = state !== null && typeof state === "object" && "previewContext" in state && typeof state.previewContext === "string" ? state.previewContext : null;
  const evidence = destination === "research" && (localContext === "evidence" || localContext === "evidence-source");
  const context = evidence && localContext === "evidence-source";
  const sourceDialog = destination !== "sources" || localContext === null ? null
    : localContext === "source-add" ? { kind: "add" as const }
    : localContext.startsWith("source-reader:") ? { kind: "reader" as const, key: localContext.slice("source-reader:".length) } : null;
  const openContext = (next: string) => { void navigate(location.pathname, { state: { previewContext: next }, preventScrollReset: true }); };
  const closeEvidence = () => { void navigate(context ? -2 : -1); };
  useLayoutEffect(() => {
    // Project changes mount a fresh local workspace. Static route changes preserve its mounted feature roots.
    headingRef.current?.focus();
  }, [destination, headingRef]);
  return <div className="er-fixture-workspace">
    <aside className="er-shell-sources" hidden={destination !== "research"} aria-label={text.sources}>
      <h2>{text.sources}</h2>
      <p className="er-shell-eyebrow">{projectTitle}</p>
      <p>{text.nextScope}</p><strong>{text.selected(selection.length)}</strong>
      <WorkspaceLink className="er-shell-link" to="/sources">{text.choose}</WorkspaceLink>
      <div className="er-fixture-original"><p>{text.frozen(reportScope.length)}</p><p>{text.original}</p></div>
    </aside>
    <main className="er-shell-reading" id="workspace-main">
      <div className="er-fixture-project">
        <label>{text.project}<select value={project} onChange={event => onProject(event.target.value === "design" ? "design" : "knowledge")}>
          <option value="knowledge">{text.knowledge}</option><option value="design">{text.design}</option>
        </select></label>
      </div>
      <h1 id="workspace-heading" ref={headingRef} tabIndex={-1}>{text[destination]}</h1>
      <section hidden={destination !== "sources"} aria-label={text.sources}>
        <SourcesFixture locale={locale} active={destination === "sources"} selection={selection} onSelection={setSelection} dialog={sourceDialog}
          onDialogChange={next => { if (next === null) { void navigate(-1); } else { openContext(next.kind === "add" ? "source-add" : `source-reader:${next.key}`); } }} />
      </section>
      <section hidden={destination !== "research"} aria-label={text.research}>
        <p className="er-fixture-scope">{text.selected(selection.length)} · {text.frozen(reportScope.length)}</p>
        <ResearchFixture locale={locale} scopeCount={selection.length} onCitation={() => openContext("evidence")} />
      </section>
      <section hidden={destination !== "studio"} aria-label={text.studio}>
        <StudioFixture locale={locale} reportBody={text.report} />
      </section>
      <section hidden={destination !== "connections"} aria-label={text.connections}>
        <ConnectionsFixture locale={locale} />
      </section>
      <p className="er-shell-note er-fixture-note">{text.sample}</p>
    </main>
    <Dialog open={evidence} title={text.evidence} onClose={closeEvidence}>
      <p className="er-fixture-evidence-label">{text.citationState}</p>
      <blockquote className="er-fixture-excerpt">{text.passage}</blockquote>
      <p>{text.context}</p>
      <Button variant="text" onClick={() => { if (context) { void navigate(-1); } else { openContext("evidence-source"); } }} aria-expanded={context}>{text.sourceContext}</Button>
      {context && <p className="er-fixture-context">{text.report}</p>}
      <Button variant="tonal" onClick={closeEvidence}>{text.back}</Button>
    </Dialog>
  </div>;
}
