import { Link, NavLink, Outlet, useLocation } from "react-router";
import { MaterialSymbol } from "./ui/MaterialSymbol";
import type { ThemeMode } from "./theme";

export interface ShellProps {
  readonly theme: ThemeMode;
  readonly onThemeChange: (next: ThemeMode) => void;
}

export function Shell({ theme, onThemeChange }: ShellProps) {
  const pathname = useLocation().pathname;
  const projectId = /^\/p\/([^/]+)/.exec(pathname)?.[1];
  return (
    <div className="er-shell">
      <a className="er-shell-skip" href="#workspace-main">Skip to workspace</a>
      <header className="er-shell-header">
        <NavLink className="er-shell-brand" to="/" aria-label="Eliot Research">
          <span className="er-shell-brand-mark">
            <MaterialSymbol name="spark" />
          </span>
          <span className="er-shell-brand-name">Eliot Research</span>
        </NavLink>
        <details className="er-shell-preferences">
          <summary aria-label="Appearance">
            <MaterialSymbol name={theme === "dark" ? "dark-mode" : "light-mode"} />
            <span>Appearance</span>
          </summary>
          <div className="er-shell-preferences-panel">
            <p className="er-shell-preferences-title">Appearance</p>
            <label htmlFor="appearance-select">
              Appearance
              <select
                id="appearance-select"
                value={theme}
                onChange={(event) => onThemeChange(event.target.value as ThemeMode)}
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
          </div>
        </details>
      </header>
      <nav className="er-shell-nav" aria-label="Primary">
        <Link className="er-shell-destination" to="/" aria-current={pathname === "/" ? "page" : undefined}>
          <span className="er-shell-destination-icon">
            <MaterialSymbol name="home" />
          </span>
          <span className="er-shell-destination-label">Projects</span>
        </Link>
        {projectId ? <>
          <Link className="er-shell-destination" to={`/p/${projectId}/sources`} aria-current={pathname.includes("/source") ? "page" : undefined}><span className="er-shell-destination-icon"><MaterialSymbol name="home" /></span><span className="er-shell-destination-label">Sources</span></Link>
          <NavLink className="er-shell-destination" to={`/p/${projectId}/chat`}><span className="er-shell-destination-icon"><MaterialSymbol name="spark" /></span><span className="er-shell-destination-label">Chat</span></NavLink>
          <NavLink className="er-shell-destination" to={`/p/${projectId}/studio`}><span className="er-shell-destination-icon"><MaterialSymbol name="info" /></span><span className="er-shell-destination-label">Studio</span></NavLink>
        </> : null}
        <NavLink className="er-shell-destination" to="/settings">
          <span className="er-shell-destination-icon">
            <MaterialSymbol name="settings" />
          </span>
          <span className="er-shell-destination-label">Settings</span>
        </NavLink>
      </nav>
      <main className="er-shell-reading" id="workspace-main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
