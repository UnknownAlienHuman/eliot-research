import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { fetchMe } from "./api";
import { Shell } from "./Shell";
import { useTheme } from "./theme";
import { MaterialSymbol } from "./ui/MaterialSymbol";
import { Library, Projects, Reader } from "./Library";

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
        <Route path="settings" element={
          <>
            <h1 id="workspace-heading" tabIndex={-1}>Settings</h1>
            <section className="er-shell-settings-row">
              <h2>Workspace access</h2>
              <p>{identity}</p>
            </section>
            <section className="er-shell-settings-row">
              <h2>Appearance</h2>
              <p>Choose Light, Dark or System from the Appearance menu.</p>
            </section>
          </>
        } />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
