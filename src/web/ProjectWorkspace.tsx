import { useCallback, useEffect, useState } from "react";
import { Link, Route, Routes, useLocation, useMatch, useNavigate, useParams } from "react-router";
import type { Project, SourceSelection } from "../shared/api";
import { ChatView, StudioView } from "./Chat";
import { Reader, SourcesPane } from "./Library";
import { ProjectOverview } from "./Understanding";
import "./project-workspace.css";

export function ProjectWorkspace() {
  const { projectId = "" } = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const chatRoute = useMatch("/p/:projectId/chat/:chatId?");
  const routeChatId = chatRoute?.params.chatId;
  const [lastChatId, setLastChatId] = useState<string | undefined>(routeChatId);
  const [selection, setSelection] = useState<SourceSelection>({ scopeMode: "project_default", sourceIds: [] });
  const [pageRefresh, setPageRefresh] = useState(0);
  const [project, setProject] = useState<Project>();
  const [projectError, setProjectError] = useState("");
  const selectedChatId = routeChatId ?? lastChatId;
  const reading = pathname.includes("/source/") || pathname.endsWith("/overview");
  const activePane = pathname.includes("/source") ? "sources" : pathname.endsWith("/studio") || pathname.endsWith("/overview") ? "studio" : "chat";
  const chatPath = "/p/" + encodeURIComponent(projectId) + "/chat" + (selectedChatId ? "/" + encodeURIComponent(selectedChatId) : "");

  useEffect(() => {
    if (routeChatId !== undefined) setLastChatId(routeChatId);
  }, [routeChatId]);
  const isChatRoute = chatRoute !== null;
  useEffect(() => {
    if (isChatRoute && routeChatId === undefined && lastChatId) navigate("/p/" + encodeURIComponent(projectId) + "/chat/" + encodeURIComponent(lastChatId), { replace: true });
  }, [routeChatId, isChatRoute, lastChatId, projectId, navigate]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/projects/" + encodeURIComponent(projectId), { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Could not open this project.");
        return response.json() as Promise<{ project: Project }>;
      })
      .then(data => { if (!controller.signal.aborted) { setProject(data.project); setProjectError(""); } })
      .catch((error: unknown) => { if (!controller.signal.aborted) setProjectError(error instanceof Error ? error.message : "Could not open this project."); });
    return () => controller.abort();
  }, [projectId]);
  const newChat = useCallback(() => setLastChatId(undefined), []);
  const savedPage = useCallback(() => setPageRefresh(value => value + 1), []);

  return <section className="er-project-workspace" data-active-pane={activePane} data-reading={reading}>
    <header className="er-project-workspace__header">
      <h1 id="workspace-heading" tabIndex={-1}>{project?.title ?? "Project"}</h1>
      {reading ? <Link className="er-button er-button--text" to={chatPath}>Back to chat</Link> : null}
      {projectError ? <p className="er-status er-status--error" role="alert">{projectError}</p> : null}
    </header>
    <div className="er-project-workspace__panes">
      <aside className="er-project-workspace__pane er-project-workspace__pane--sources" aria-label="Project sources">
        <SourcesPane projectId={projectId} selection={selection} onSelectionChange={setSelection} />
      </aside>
      <div className="er-project-workspace__pane er-project-workspace__pane--chat">
        <div className="er-project-workspace__chat" hidden={reading}>
          <ChatView projectId={projectId} {...(selectedChatId === undefined ? {} : { chatId: selectedChatId })} selection={selection}
            onSelectionChange={setSelection} onNewChat={newChat} onSavedPage={savedPage}
            {...(project?.answerModel === undefined ? {} : { projectAnswerModel: project.answerModel })} />
        </div>
        <div className="er-project-workspace__reader" hidden={!reading}>
          <Routes>
            <Route path="source/:sourceId" element={<Reader />} />
            <Route path="overview" element={<ProjectOverview />} />
            <Route path="*" element={null} />
          </Routes>
        </div>
      </div>
      <aside className="er-project-workspace__pane er-project-workspace__pane--studio" aria-label="Project Studio">
        <StudioView projectId={projectId} refreshKey={pageRefresh} />
      </aside>
    </div>
  </section>;
}
