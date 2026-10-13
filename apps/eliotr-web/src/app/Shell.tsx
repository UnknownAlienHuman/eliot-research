import { Suspense, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import { useLocation } from "react-router";
import { WorkspaceLink } from "../routes/WorkspaceLink";
import { Button, MaterialSymbol, Status } from "@eliotr/ui";
import type { MaterialSymbolName } from "@eliotr/ui";
import { destinations, workspacePath, decodeWorkspaceLocation } from "../routes/location";
import type { PrivacyController } from "./privacy";
import { LiveWorkspace } from "./LiveWorkspace";
import "./shell.css";
import type { WorkspaceRuntime } from "./runtime";
import type { FixtureWorkspace } from "./FixtureWorkspace";

const copy = {
  en: { projects: "Projects", projectsBody: "Open a project to work with its sources, research and saved reports.", sources: "Sources", research: "Research", studio: "Studio", connections: "Connections", skip: "Skip to workspace", preview: "Design preview · synthetic workspace", scope: "Your research, in context", subtitle: "Keep the question, its sources and the evidence together.", sourceBody: "Add and review sources before choosing the scope of your next question.", researchBody: "Choose sources to begin. Every report will keep its original source scope.", studioBody: "Return to saved reports and supported artifacts here.", connectionsBody: "Owner access, provider configuration and research readiness are separate facts.", unknown: "Verification is unavailable", unavailable: "Your workspace needs a fresh access check before research can continue.", retry: "Check access again", review: "Review connections", language: "Language", theme: "Appearance", light: "Light", dark: "Dark", list: "No sources selected", note: "U1 shell preview. No source, report or provider request is made." },
  ru: { projects: "Проекты", projectsBody: "Откройте проект, чтобы работать с его источниками, исследованиями и сохранёнными отчётами.", sources: "Источники", research: "Исследование", studio: "Студия", connections: "Подключения", skip: "Перейти к рабочей области", preview: "Макет интерфейса · учебное пространство", scope: "Исследование с сохранением контекста", subtitle: "Вопрос, источники и доказательства остаются рядом.", sourceBody: "Добавьте и проверьте источники, затем выберите область следующего вопроса.", researchBody: "Выберите источники для начала. Каждый отчёт сохраняет первоначальную область исследования.", studioBody: "Здесь можно вернуться к сохранённым отчётам и поддерживаемым материалам.", connectionsBody: "Доступ владельца, настройки провайдера и готовность исследования — отдельные факты.", unknown: "Проверка доступа недоступна", unavailable: "Чтобы продолжить исследование, необходима новая проверка доступа к рабочему пространству.", retry: "Проверить доступ снова", review: "Проверить подключения", language: "Язык", theme: "Оформление", light: "Светлое", dark: "Тёмное", list: "Источники не выбраны", note: "Предварительная оболочка. Запросы к источникам, отчётам и провайдерам не выполняются." },
} as const;
const icons: Record<typeof destinations[number], MaterialSymbolName> = { projects: "home", sources: "folder", research: "research", studio: "bookmarks", connections: "settings" };

export function Shell({ privacy, fixture, fixtureOutlet: FixtureOutlet, runtime }: {
  readonly privacy: PrivacyController;
  readonly fixture: boolean;
  readonly fixtureOutlet?: ComponentType<Parameters<typeof FixtureWorkspace>[0]>;
  readonly runtime?: WorkspaceRuntime;
}) {
  const snapshot = useSyncExternalStore(privacy.subscribe, privacy.getSnapshot, privacy.getSnapshot);
  const [locale, setLocale] = useState<"en" | "ru">("en");
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const location = useLocation();
  const destination = decodeWorkspaceLocation(location) ?? "research";
  const text = copy[locale];
  const heading = useRef<HTMLHeadingElement>(null);
  const preferences = useRef<HTMLDetailsElement>(null);
  const preferencesId = useId();
  useLayoutEffect(() => {
    if (preferences.current) preferences.current.open = false;
    if (privacy.commitVisible(snapshot)) heading.current?.focus();
  }, [privacy, snapshot, destination]);
  if (snapshot.phase === "verifying") return null;
  if (snapshot.phase === "unavailable") return (
    <main className="er-access" lang={locale}>
      <MaterialSymbol name="research" />
      <p className="er-shell-eyebrow">Eliot Research</p>
      <h1 ref={heading} tabIndex={-1}>{text.unknown}</h1>
      <p>{text.unavailable}</p>
      <Button onClick={() => { void privacy.refresh(); }}>{text.retry}</Button>
    </main>
  );
  const body = { projects: text.projectsBody, sources: text.sourceBody, research: text.researchBody, studio: text.studioBody, connections: text.connectionsBody }[destination];
  const apis = runtime?.read(snapshot.context);
  return (
    <div key={snapshot.context.cacheEpoch} className="er-shell" lang={locale} data-theme={theme} data-destination={destination}>
      <a className="er-shell-skip" href="#workspace-heading">{text.skip}</a>
      <header className="er-shell-header">
        <WorkspaceLink className="er-shell-brand" to="/projects" aria-label="Eliot Research">
          <span className="er-shell-brand-mark"><MaterialSymbol name="spark" /></span>
          <span className="er-shell-brand-name">Eliot Research</span>
        </WorkspaceLink>
        {fixture && <p className="er-shell-preview">{text.preview}</p>}
        <details ref={preferences} className="er-shell-preferences" onKeyDown={event => {
          if (event.key === "Escape" && preferences.current?.open) {
            event.stopPropagation(); preferences.current.open = false;
            preferences.current.querySelector("summary")?.focus();
          }
        }}>
          <summary aria-label={locale === "ru" ? "Настройки интерфейса" : "Workspace preferences"}>
            <MaterialSymbol name={theme === "dark" ? "dark-mode" : "light-mode"} /><span>{locale === "ru" ? "Настройки" : "Preferences"}</span>
          </summary>
          <div className="er-shell-preferences-panel">
            <p className="er-shell-preferences-title">{locale === "ru" ? "Настройки" : "Preferences"}</p>
            <label htmlFor={preferencesId + '-language'}>{text.language}<select id={preferencesId + '-language'} aria-label={text.language} value={locale} onChange={event => setLocale(event.target.value === "ru" ? "ru" : "en")}><option value="en">English</option><option value="ru">Русский</option></select></label>
            <label htmlFor={preferencesId + '-theme'}>{text.theme}<select id={preferencesId + '-theme'} aria-label={text.theme} value={theme} onChange={event => setTheme(event.target.value === "dark" ? "dark" : "light")}><option value="light">{text.light}</option><option value="dark">{text.dark}</option></select></label>
          </div>
        </details>
      </header>
      <nav className="er-shell-nav" aria-label={text.scope}>
        {destinations.map(item => <WorkspaceLink key={item} to={workspacePath(item)} className="er-shell-destination">
          <span className="er-shell-destination-icon"><MaterialSymbol name={icons[item]} /></span>
          <span className="er-shell-destination-label">{text[item]}</span>
        </WorkspaceLink>)}
      </nav>
      {fixture && FixtureOutlet ? <Suspense fallback={<Status>{text.scope}</Status>}><FixtureOutlet destination={destination} locale={locale} headingRef={heading} /></Suspense> : apis ? <LiveWorkspace destination={destination} locale={locale} headingRef={heading} apis={apis} privacy={privacy} context={snapshot.context} /> : <><aside className="er-shell-sources" hidden={destination !== "research"} aria-label={text.sources}>
        <h2>{text.sources}</h2><Status>{text.list}</Status><p>{text.sourceBody}</p>
        <WorkspaceLink className="er-shell-link" to="/sources">{text.sources}</WorkspaceLink>
      </aside>
      <main className="er-shell-reading" id="workspace-main">
        <p className="er-shell-eyebrow">{text.scope}</p>
        <h1 id="workspace-heading" ref={heading} tabIndex={-1}>{text[destination]}</h1>
        <p className="er-shell-lead">{text.subtitle}</p>
        <div className="er-shell-empty"><MaterialSymbol name={icons[destination]} /><h2>{body}</h2>{destination !== "connections" && <WorkspaceLink className="er-shell-link" to="/connections">{text.review}</WorkspaceLink>}</div>
        {fixture && <p className="er-shell-note">{text.note}</p>}
      </main>
      </>}
    </div>
  );
}
