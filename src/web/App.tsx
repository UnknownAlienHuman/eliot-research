import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router";
import { fetchMe } from "./api";
import { Shell } from "./Shell";
import { useTheme } from "./theme";
import { MaterialSymbol } from "./ui/MaterialSymbol";
import { Library, Projects, Reader } from "./Library";
import { ChatView, StudioView } from "./Chat";
import { ModelSettings } from "./ModelSettings";
import { ProjectOverview } from "./Understanding";
import { ProjectKnowledge } from "./ProjectKnowledge";

function KnowledgeOverview() {
  const { projectId = "" } = useParams();
  return <><ProjectKnowledge projectId={projectId} /><ProjectOverview projectId={projectId} /></>;
}

export function App() {
  const { pathname } = useLocation();
  const [theme, setTheme] = useTheme();
  const me = useQuery({ queryKey: ["me"], queryFn: ({ signal }) => fetchMe(signal), retry: false });
  if (me.isPending) {
    return (
      <main className="er-access" aria-busy="true">
        <MaterialSymbol name="spark" />
        <p role="status">Opening your workspace…</p>
      </main>
    );
  }
  if (me.isError) {
    return (
      <main className="er-access" role="alert">
        <MaterialSymbol name="error" />
        <h1>Unable to open your workspace</h1>
        <p>Check your connection and Cloudflare Access sign-in, then try again.</p>
        <button className="er-button er-button--primary" onClick={() => void me.refetch()}>Try again</button>
      </main>
    );
  }
  const identity = me.data.actor.email
    ?? (me.data.actor.authentication === "local" ? "Local development session" : "Owner service token");
  return (
    <Routes>
      <Route element={<Shell theme={theme} onThemeChange={setTheme} />}>
        <Route index element={<Projects />} />
        <Route path="p/:projectId/sources" element={<Library key={pathname} />} />
        <Route path="p/:projectId/source/:sourceId" element={<Reader key={pathname} />} />
        <Route path="p/:projectId/chat/:chatId?" element={<ChatView key={pathname} />} />
        <Route path="p/:projectId/studio" element={<StudioView key={pathname} />} />
        <Route path="p/:projectId/overview" element={<KnowledgeOverview key={pathname} />} />
        <Route path="settings" element={
          <>
            <h1 id="workspace-heading" tabIndex={-1}>Settings</h1>
            <div className="er-shell-settings-list">
              <ModelSettings />
              <section className="er-shell-settings-row er-shell-settings-row--preferences" aria-label="Workspace preferences">
                <div><h2>Workspace</h2><p>{identity}</p></div>
                <label>Appearance
                  <select value={theme} onChange={(event) => setTheme(event.target.value as typeof theme)}>
                    <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
                  </select>
                </label>
              </section>
            </div>
          </>
        } />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
