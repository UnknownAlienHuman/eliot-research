import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { NavLink, useLocation } from "react-router";
import { Button, MaterialSymbol, Status } from "@eliotr/ui";
import type { MaterialSymbolName } from "@eliotr/ui";
import { destinations, workspacePath, decodeWorkspaceLocation } from "../routes/location";
import type { PrivacyController } from "./privacy";
import { FixtureWorkspace } from "./FixtureWorkspace";
import "./shell.css";

const copy = {
  en: { sources: "Sources", research: "Research", studio: "Studio", connections: "Connections", skip: "Skip to workspace", preview: "Design preview · synthetic workspace", scope: "Your research, in context", subtitle: "Keep the question, its sources and the evidence together.", sourceBody: "Add and review sources before choosing the scope of your next question.", researchBody: "Choose sources to begin. Every report will keep its original source scope.", studioBody: "Return to saved reports and supported artifacts here.", connectionsBody: "Owner access, provider configuration and research readiness are separate facts.", unknown: "Verification is unavailable", unavailable: "Your workspace needs a fresh access check before research can continue.", retry: "Check access again", review: "Review connections", language: "Language", theme: "Appearance", light: "Light", dark: "Dark", list: "No sources selected", note: "U1 shell preview. No source, report or provider request is made." },
  ru: { sources: "Источники", research: "Исследование", studio: "Студия", connections: "Подключения", skip: "Перейти к рабочей области", preview: "Макет интерфейса · учебное пространство", scope: "Исследование с сохранением контекста", subtitle: "Вопрос, источники и доказательства остаются рядом.", sourceBody: "Добавьте и проверьте источники, затем выберите область следующего вопроса.", researchBody: "Выберите источники для начала. Каждый отчёт сохраняет первоначальную область исследования.", studioBody: "Здесь можно вернуться к сохранённым отчётам и поддерживаемым материалам.", connectionsBody: "Доступ владельца, настройки провайдера и готовность исследования — отдельные факты.", unknown: "Проверка доступа недоступна", unavailable: "Чтобы продолжить исследование, необходима новая проверка доступа к рабочему пространству.", retry: "Проверить доступ снова", review: "Проверить подключения", language: "Язык", theme: "Оформление", light: "Светлое", dark: "Тёмное", list: "Источники не выбраны", note: "Предварительная оболочка. Запросы к источникам, отчётам и провайдерам не выполняются." },
} as const;
const icons: Record<typeof destinations[number], MaterialSymbolName> = { sources: "folder", research: "research", studio: "bookmarks", connections: "settings" };

export function Shell({ privacy, fixture }: { readonly privacy: PrivacyController; readonly fixture: boolean }) {
  const snapshot = useSyncExternalStore(privacy.subscribe, privacy.getSnapshot, privacy.getSnapshot);
  const [locale, setLocale] = useState<"en" | "ru">("en");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const location = useLocation();
  const destination = decodeWorkspaceLocation(location) ?? "research";
  const text = copy[locale];
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
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
  const body = { sources: text.sourceBody, research: text.researchBody, studio: text.studioBody, connections: text.connectionsBody }[destination];
  return (
    <div key={snapshot.context.cacheEpoch} className="er-shell" lang={locale} data-theme={theme} data-destination={destination}>
      <a className="er-shell-skip" href="#workspace-heading">{text.skip}</a>
      <header className="er-shell-header">
        <NavLink className="er-shell-brand" to="/research" aria-label="Eliot Research"><MaterialSymbol name="research" /><span>Eliot Research</span></NavLink>
        <p className="er-shell-preview">{fixture ? text.preview : text.scope}</p>
        <label>{text.language}<select value={locale} onChange={event => setLocale(event.target.value === "ru" ? "ru" : "en")}><option value="en">English</option><option value="ru">Русский</option></select></label>
        <label>{text.theme}<select value={theme} onChange={event => setTheme(event.target.value === "dark" ? "dark" : "light")}><option value="light">{text.light}</option><option value="dark">{text.dark}</option></select></label>
      </header>
      <nav className="er-shell-nav" aria-label={text.scope}>
        {destinations.map(item => <NavLink key={item} to={workspacePath(item)} className="er-shell-destination"><span><MaterialSymbol name={icons[item]} /></span>{text[item]}</NavLink>)}
      </nav>
      {fixture ? <FixtureWorkspace destination={destination} locale={locale} headingRef={heading} /> : <><aside className="er-shell-sources" hidden={destination !== "research"} aria-label={text.sources}>
        <h2>{text.sources}</h2><Status>{text.list}</Status><p>{text.sourceBody}</p>
        <NavLink className="er-shell-link" to="/sources">{text.sources}</NavLink>
      </aside>
      <main className="er-shell-reading" id="workspace-main">
        <p className="er-shell-eyebrow">{text.scope}</p>
        <h1 id="workspace-heading" ref={heading} tabIndex={-1}>{text[destination]}</h1>
        <p className="er-shell-lead">{text.subtitle}</p>
        <div className="er-shell-empty"><MaterialSymbol name={icons[destination]} /><h2>{body}</h2>{destination !== "connections" && <NavLink className="er-shell-link" to="/connections">{text.review}</NavLink>}</div>
        {fixture && <p className="er-shell-note">{text.note}</p>}
      </main>
      </>}
    </div>
  );
}
