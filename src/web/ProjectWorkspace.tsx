import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, Route, Routes, useLocation, useMatch, useNavigate, useParams } from "react-router";
import type { Project, SourceSelection } from "../shared/api";
import { ChatView, StudioView } from "./Chat";
import { Reader, SourcesPane } from "./Library";
import type { SourceReplacementProps } from "./Library";
import { ProjectOverview } from "./Understanding";
import type { SuggestedQuestion } from "./Understanding";
import { ProjectPicker } from "./ProjectPicker";
import "./project-workspace.css";

export function ProjectWorkspace(replacements: SourceReplacementProps) {
  const { projectId = "" } = useParams();
  const location = useLocation();
  const { pathname } = location;
  const navigate = useNavigate();
  const chatRoute = useMatch("/p/:projectId/chat/:chatId?");
  const routeChatId = chatRoute?.params.chatId;
  const [lastChatId, setLastChatId] = useState<string | undefined>(routeChatId);
  const [selection, setSelection] = useState<SourceSelection>({ scopeMode: "project_default", sourceIds: [] });
  const [question, setQuestion] = useState("");
  const [pendingQuestion, setPendingQuestion] = useState<(SuggestedQuestion & { path: string; search: string; key: string }) | null>(null);
  const draftDialog = useRef<HTMLDialogElement | null>(null);
  const draftHeading = useId();
  const [pageRefresh, setPageRefresh] = useState(0);
  const [project, setProject] = useState<Project>();
  const [projectError, setProjectError] = useState("");
  const selectedChatId = routeChatId ?? lastChatId;
  const reading = pathname.includes("/source/") || pathname.endsWith("/overview");
  const activePane = pathname.includes("/source") ? "sources" : pathname.endsWith("/studio") || pathname.endsWith("/overview") ? "studio" : "chat";
  const chatPath = "/p/" + encodeURIComponent(projectId) + "/chat" + (selectedChatId ? "/" + encodeURIComponent(selectedChatId) : "");

  useEffect(() => { setPendingQuestion(null); }, [pathname, location.search, location.key]);
  useEffect(() => {
    const dialog = draftDialog.current;
    if (pendingQuestion && dialog && !dialog.open) dialog.showModal();
    return () => { dialog?.close(); };
  }, [pendingQuestion]);
  function applyQuestion(suggestion: SuggestedQuestion): void {
    setQuestion(suggestion.question);
    setSelection({ scopeMode: "explicit", sourceIds: [suggestion.sourceId] });
    setPendingQuestion(null);
    navigate(chatPath);
  }
  function requestQuestion(suggestion: SuggestedQuestion): void {
    if (!suggestion.question.trim()) return;
    if (question.trim() && question !== suggestion.question) {
      setPendingQuestion({ ...suggestion, path: pathname, search: location.search, key: location.key });
    } else applyQuestion(suggestion);
  }

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
      <ProjectPicker projectId={projectId} />
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
            question={question} onQuestionChange={setQuestion}
            onSelectionChange={setSelection} onNewChat={newChat} onSavedPage={savedPage}
            {...(project?.answerModel === undefined ? {} : { projectAnswerModel: project.answerModel })} />
        </div>
        <div className="er-project-workspace__reader" hidden={!reading}>
          <Routes>
            <Route path="source/:sourceId" element={<Reader {...replacements} onUseQuestion={requestQuestion} />} />
            <Route path="overview" element={<ProjectOverview onUseQuestion={requestQuestion} />} />
            <Route path="*" element={null} />
          </Routes>
        </div>
      </div>
      <aside className="er-project-workspace__pane er-project-workspace__pane--studio" aria-label="Project Studio">
        <StudioView projectId={projectId} refreshKey={pageRefresh} />
      </aside>
    </div>
    {pendingQuestion ? <dialog ref={draftDialog} className="er-dialog er-project-workspace__draft" aria-labelledby={draftHeading} onClose={() => setPendingQuestion(null)}>
      <h2 className="er-dialog__title" id={draftHeading}>Replace chat draft</h2>
      <div className="er-dialog__body">
        <p>Your unsent draft will be replaced, and only {pendingQuestion.sourceTitle} selected. Review the question in chat before Send.</p>
        <p>{pendingQuestion.question}</p>
        <div className="er-und__actions">
          <button className="er-button er-button--text" type="button" autoFocus onClick={() => draftDialog.current?.close()}>Keep draft</button>
          <button className="er-button er-button--primary" type="button" onClick={() => {
            if (pendingQuestion.path === pathname && pendingQuestion.search === location.search && pendingQuestion.key === location.key) applyQuestion(pendingQuestion);
            else setPendingQuestion(null);
          }}>Use suggested question</button>
        </div>
      </div>
    </dialog> : null}
  </section>;
}
