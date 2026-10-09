import { useEffect, useId, useRef, useState } from "react";
import { MaterialSymbol } from "./MaterialSymbol";
import { Button, Dialog, Field } from "../primitives/primitives";
import "./workspace-direction.css";

type Destination = "sources" | "research" | "studio" | "connections";
export type DirectionState = "useful" | "loading" | "degraded";
export interface WorkspaceDirectionProps {
  readonly locale?: "en" | "ru";
  readonly theme?: "light" | "dark";
  readonly state?: DirectionState;
}

const content = {
  en: {
    sources: "Sources", research: "Research", studio: "Studio", connections: "Connections",
    notebook: "Knowledge, with context", project: "A better way to work with evidence",
    add: "Add sources", scope: "Selected for your next question", selected: "sources selected",
    sourceTitles: ["Designing knowledge systems for people", "What makes a trustworthy research workflow?", "Material Design: clarity, hierarchy and focus"],
    sourceTypes: ["Document · 12 pages", "Article · 8 min read", "Reference · 6 sections"],
    ready: "Ready for research", earlier: "An earlier revision is available", readyBody: "The original report keeps its original source scope.",
    question: "What makes evidence useful?", prompt: "Ask a question about your sources", start: "Research",
    reportLabel: "Research report", reportTitle: "From information to understanding",
    intro: "Useful evidence does more than support an answer. It lets you see where a claim comes from, understand its limits, and return to the original context.",
    heading: "Keep the source close to the claim", paragraph: "A clear research workspace connects a question to a selected set of sources. Citations carry that context forward, so you can check an exact passage without losing your place.",
    finding: "What the sources agree on", conclusion: "Make scope explicit. Keep reading surfaces calm. Show uncertainty in words, and make it easy to recover when a source changes.",
    citation: "Open citation 1", evidence: "Evidence", closeEvidence: "Back to report", passage: "“Clarity starts with a clear relationship between the question, the source, and the claim.”",
    evidenceNote: "Sample passage · original report revision", openSource: "View source context",
    saved: "Saved work", savedTitle: "Research you can return to", savedBody: "Save accepted reports and supported artifacts here. Your sources and their revisions stay attached.",
    savedReport: "From information to understanding", savedKind: "Saved report · 3 sources",
    connectionTitle: "Understand what is available", connectionBody: "Access, provider configuration and research readiness are separate facts.",
    access: "Owner access", accessState: "Needs verification", provider: "Research provider", providerState: "Configuration unknown", verify: "Review connection details",
    loading: "Research is in progress", loadingBody: "Reading your selected sources. The report will appear here when its required sections are available.",
    degraded: "Some evidence needs another check", degradedBody: "The report remains readable. Source verification is unavailable, so the citation is not confirmed as current.",
    retry: "Check again", sample: "Design preview · synthetic sources", scopeNote: "New selections apply to your next question.",
    emptyScope: "Select a source before starting research.",
  },
  ru: {
    sources: "Источники", research: "Исследование", studio: "Студия", connections: "Подключения",
    notebook: "Знания в контексте", project: "Как работать с доказательствами и сохранять контекст исследования",
    add: "Добавить источники", scope: "Для следующего вопроса", selected: "источника выбрано",
    sourceTitles: ["Проектирование систем знаний, которыми удобно пользоваться каждый день", "Что делает исследовательский процесс надёжным и проверяемым?", "Material Design: ясность, иерархия и внимание к содержанию"],
    sourceTypes: ["Документ · 12 страниц", "Статья · 8 минут чтения", "Справочник · 6 разделов"],
    ready: "Готов к исследованию", earlier: "Доступна предыдущая версия", readyBody: "Исходный отчёт сохраняет первоначальный набор источников.",
    question: "Какие доказательства помогают понять ответ?", prompt: "Задайте вопрос по выбранным источникам", start: "Исследовать",
    reportLabel: "Исследовательский отчёт", reportTitle: "От информации к пониманию",
    intro: "Полезные доказательства не только подкрепляют ответ. Они помогают увидеть происхождение утверждения, понять ограничения и вернуться к первоначальному контексту, сохраняя связь с точной версией источника.",
    heading: "Держите источник рядом с утверждением", paragraph: "Понятное рабочее пространство связывает вопрос с выбранным набором источников. Цитаты сохраняют эту связь: можно проверить конкретный фрагмент и вернуться к чтению без потери своего места.",
    finding: "В чём источники согласны", conclusion: "Показывайте область исследования явно. Оставляйте место для спокойного чтения. Объясняйте неопределённость словами и помогайте восстановить контекст, если источник изменился.",
    citation: "Открыть цитату 1", evidence: "Доказательство", closeEvidence: "Вернуться к отчёту", passage: "«Ясность начинается с понятной связи между вопросом, источником и утверждением». ",
    evidenceNote: "Пример фрагмента · версия исходного отчёта", openSource: "Открыть контекст источника",
    saved: "Сохранённые материалы", savedTitle: "К исследованию можно вернуться", savedBody: "Здесь сохраняются принятые отчёты и поддерживаемые материалы. Связь с источниками и их версиями остаётся доступной.",
    savedReport: "От информации к пониманию", savedKind: "Сохранённый отчёт · 3 источника",
    connectionTitle: "Что сейчас доступно", connectionBody: "Доступ владельца, настройки провайдера и готовность исследования проверяются отдельно.",
    access: "Доступ владельца", accessState: "Требуется проверка", provider: "Провайдер исследования", providerState: "Настройки неизвестны", verify: "Проверить подключения",
    loading: "Исследование выполняется", loadingBody: "Читаем выбранные источники. Отчёт появится здесь, когда обязательные разделы станут доступны.",
    degraded: "Часть доказательств требует проверки", degradedBody: "Отчёт доступен для чтения. Проверка источника временно недоступна: актуальность цитаты пока не подтверждена.",
    retry: "Проверить ещё раз", sample: "Макет интерфейса · учебные источники", scopeNote: "Новый выбор применяется к следующему вопросу.",
    emptyScope: "Выберите источник перед началом исследования.",
  },
} as const;

/** Local direction fixture. No endpoint, provider, admission or completion authority. */
export function WorkspaceDirection({ locale = "en", theme = "light", state = "useful" }: WorkspaceDirectionProps) {
  const text = content[locale];
  const scopeId = useId();
  const [destination, setDestination] = useState<Destination>("research");
  const [selected, setSelected] = useState([true, true, true]);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [previewState, setPreviewState] = useState(state);
  const [review, setReview] = useState<"source" | "connections" | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [addedSource, setAddedSource] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState(false);
  const citationButton = useRef<HTMLButtonElement>(null);
  const evidenceBackButton = useRef<HTMLButtonElement>(null);
  const sourcesPane = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const selectedCount = selected.filter(Boolean).length;
  const skipTarget = evidenceOpen ? "direction-evidence" : destination === "sources" ? "direction-sources" : "direction-reading";
  const destinations: readonly Destination[] = ["sources", "research", "studio", "connections"];
  useEffect(() => { setPreviewState(state); }, [state]);
  useEffect(() => {
    if (evidenceOpen) evidenceBackButton.current?.focus();
    else if (returnFocus.current) { returnFocus.current.focus(); returnFocus.current = null; }
  }, [evidenceOpen]);
  function closeEvidence() { returnFocus.current = citationButton.current; setEvidenceOpen(false); }

  return (
    <div className="er-workspace" data-theme={theme} data-destination={destination} data-evidence={evidenceOpen} lang={locale} onKeyDown={(event) => { if (evidenceOpen && event.key === "Escape") closeEvidence(); }}>
      <a className="er-skip" href={`#${skipTarget}`}>{locale === "ru" ? "Перейти к содержимому" : "Skip to content"}</a>
      <header className="er-topbar">
        <a className="er-brand" href="#direction-main"><span className="er-brand-mark" aria-hidden="true">e</span><span>Eliot <span className="er-brand-secondary">Research</span></span></a>
        <p className="er-project-label">{text.notebook}</p>
        <span className="er-preview-note">{text.sample}</span>
      </header>
      <nav className="er-destinations" aria-label={locale === "ru" ? "Рабочее пространство" : "Workspace"}>
        {destinations.map((item) => (
          <button key={item} type="button" className="er-destination" aria-current={destination === item ? "page" : undefined} onClick={() => { setDestination(item); setEvidenceOpen(false); }}>
            <span className="er-nav-symbol" aria-hidden="true"><MaterialSymbol name={item === "sources" ? "folder" : item === "research" ? "research" : item === "studio" ? "bookmarks" : "settings"} /></span>
            <span>{text[item]}</span>
          </button>
        ))}
      </nav>
      <main id="direction-main" className="er-task-landmark">
      <aside ref={sourcesPane} id="direction-sources" className="er-sources er-pane" aria-label={text.sources} tabIndex={-1}>
        <div className="er-pane-title"><h2>{text.sources}</h2><span className="er-count">{addedSource ? 4 : 3}</span></div>
        <Button variant="tonal" icon="add" onClick={() => { setSourceError(false); setReview("source"); }}>{text.add}</Button>
        <fieldset className="er-source-list">
          <legend>{text.scope}</legend>
          {text.sourceTitles.map((title, index) => (
            <label className="er-source-row" key={title}>
              <input type="checkbox" checked={selected[index]} onChange={(event) => setSelected(selected.map((value, item) => item === index ? event.target.checked : value))} />
              <span><strong>{title}</strong><span className="er-secondary">{text.sourceTypes[index]}</span><span className="er-source-state">{index === 1 ? text.earlier : text.ready}</span></span>
            </label>
          ))}
        </fieldset>
        {addedSource && <div className="er-source-row"><MaterialSymbol name="file" /><span><strong>{addedSource}</strong><span className="er-source-state">{locale === "ru" ? "Записан в макете · ещё не принят для исследования" : "Captured in preview · not admitted for research"}</span></span></div>}
        <p className="er-scope-note">{text.scopeNote}</p>
      </aside>
      <section id="direction-reading" className="er-reading er-pane" aria-label={text[destination]} tabIndex={-1}>
        <section className="er-research-content" hidden={destination === "studio" || destination === "connections"}>
          <div className="er-notebook-heading"><p className="er-eyebrow">{text.notebook}</p><h1>{text.project}</h1></div>
          <form className="er-composer" onSubmit={(event) => { event.preventDefault(); if (selectedCount > 0) setPreviewState("loading"); }}>
            <label htmlFor={scopeId}>{text.prompt}</label>
            <textarea id={scopeId} defaultValue={text.question} rows={2} required aria-describedby={`${scopeId}-scope`} />
            <div className="er-composer-bottom"><span id={`${scopeId}-scope`}>{selectedCount} {text.selected}</span><Button icon="send" type="submit" disabled={selectedCount === 0 || previewState === "loading"}>{text.start}</Button></div>
            {selectedCount === 0 && <p role="status">{text.emptyScope}</p>}
          </form>
          {previewState === "loading" ? (
            <section className="er-progress-state" aria-live="polite"><p className="er-eyebrow">{text.reportLabel}</p><h2>{text.loading}</h2><p>{text.loadingBody}</p><progress aria-label={text.loading} /><Button variant="text" onClick={() => setPreviewState("useful")}>{locale === "ru" ? "Показать учебный отчёт" : "Show sample report"}</Button></section>
          ) : (
            <article className="er-report">
              {previewState === "degraded" && <div className="er-notice" role="status"><strong>{text.degraded}</strong><p>{text.degradedBody}</p><Button variant="text" onClick={() => setPreviewState("loading")}>{text.retry}</Button></div>}
              <p className="er-eyebrow">{text.reportLabel} <span aria-hidden="true">·</span> 3 {text.sources.toLowerCase()}</p>
              <h2>{text.reportTitle}</h2><p className="er-report-lead">{text.intro}</p>
              <h3>{text.heading}</h3><p>{text.paragraph} <button ref={citationButton} type="button" className="er-citation" aria-label={text.citation} aria-expanded={evidenceOpen} aria-controls={`${scopeId}-evidence`} onClick={() => setEvidenceOpen(true)}>1</button></p>
              <h3>{text.finding}</h3><p>{text.conclusion}</p>
              <footer className="er-report-footer">{text.readyBody}</footer>
            </article>
          )}
        </section>
        <section className="er-destination-content" hidden={destination !== "studio"}><p className="er-eyebrow">{text.saved}</p><h1>{text.savedTitle}</h1><p>{text.savedBody}</p><button type="button" className="er-saved-row" onClick={() => setDestination("research")}><strong>{text.savedReport}</strong><span>{text.savedKind}</span><span aria-hidden="true">→</span></button></section>
        <section className="er-destination-content" hidden={destination !== "connections"}><p className="er-eyebrow">{text.connections}</p><h1>{text.connectionTitle}</h1><p>{text.connectionBody}</p><dl className="er-connection-facts"><div><dt>{text.access}</dt><dd>{text.accessState}</dd></div><div><dt>{text.provider}</dt><dd>{text.providerState}</dd></div></dl><Button variant="tonal" onClick={() => setReview("connections")}>{text.verify}</Button></section>
      </section>
      <aside id={`${scopeId}-evidence`} className="er-context er-pane" aria-label={text.evidence} hidden={!evidenceOpen}>
        <button ref={evidenceBackButton} type="button" className="er-text-action" onClick={closeEvidence}>← {text.closeEvidence}</button>
        <div id="direction-evidence" tabIndex={-1}><p className="er-eyebrow">{text.evidence} 1</p><h2>{text.sourceTitles[0]}</h2></div><blockquote>{text.passage}</blockquote><p className="er-secondary">{text.evidenceNote}</p><Button variant="tonal" onClick={() => { returnFocus.current = sourcesPane.current; setEvidenceOpen(false); setDestination("sources"); }}>{text.openSource}</Button>
      </aside>
      </main>
      <Dialog open={review !== null} title={review === "source" ? text.add : text.connections} onClose={() => setReview(null)}>
        {review === "source" ? <form onSubmit={(event) => { event.preventDefault(); if (!sourceName.trim()) { setSourceError(true); return; } setAddedSource(sourceName.trim()); setSourceName(""); setReview(null); }}>
          <Field label={locale === "ru" ? "Название учебного источника" : "Sample source title"} value={sourceName} onChange={(event) => { setSourceName(event.target.value); setSourceError(false); }} {...(sourceError ? { error: locale === "ru" ? "Введите название источника" : "Enter a source title" } : {})} hint={locale === "ru" ? "Добавление не изменяет набор источников исходного отчёта." : "Adding a source preserves the original report scope."} />
          <Button type="submit" variant="tonal">{locale === "ru" ? "Добавить в макет" : "Add to preview"}</Button>
        </form> : <p>{locale === "ru" ? "Это учебный макет. Доступ и настройки неизвестны; успешное обращение к провайдеру не проверялось." : "This is a synthetic preview. Access and configuration are unknown; no successful provider call has been observed."}</p>}
        <Button variant="text" onClick={() => setReview(null)}>{locale === "ru" ? "Назад" : "Back"}</Button>
      </Dialog>
    </div>
  );
}
