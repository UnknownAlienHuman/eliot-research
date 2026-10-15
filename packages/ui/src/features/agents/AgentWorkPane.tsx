import { useId, type ReactNode } from "react";
import { MaterialSymbol } from "../../catalog/MaterialSymbol";
import {
  AGENT_WORK_COPY, TOOL_ACCENT, TOOL_ICON,
  type AgentSummary, type AgentTaskSummary, type AgentWorkLocale, type ResearchToolId,
} from "./agent-work-model";
import "./agents.css";

export interface AgentWorkPaneProps {
  readonly locale: AgentWorkLocale;
  readonly agents: readonly AgentSummary[];
  /** An unread connection list cannot establish that the workspace has no agents. */
  readonly agentsUnavailable?: boolean | undefined;
  /** Only tools the system offers for this project; anything else is a chat request. */
  readonly tools: readonly ResearchToolId[];
  readonly tasks: readonly AgentTaskSummary[];
  readonly tasksUnavailable?: boolean | undefined;
  readonly onTool: (tool: ResearchToolId) => void;
  readonly onTask?: ((taskId: string) => void) | undefined;
  readonly onManageAgents?: (() => void) | undefined;
  readonly onMoreAgents?: (() => void) | undefined;
  readonly onFirstAgents?: (() => void) | undefined;
  readonly onMoreTasks?: (() => void) | undefined;
  readonly onFirstTasks?: (() => void) | undefined;
  /** The workspace's own hand-over control, shown under the agents it can reach. */
  readonly assign?: ReactNode;
}

/**
 * The right pane of a project, as NotebookLM's Studio: owner-enabled agent connections, the system's
 * tools and handed-over tasks. Connection state and live presence remain separate observations.
 * Presentation only — the owner of the workspace decides what each callback does.
 */
export function AgentWorkPane({ locale, agents, agentsUnavailable = false, tools, tasks, tasksUnavailable = false, onTool, onTask, onManageAgents, onMoreAgents, onFirstAgents, onMoreTasks, onFirstTasks, assign }: AgentWorkPaneProps) {
  const text = AGENT_WORK_COPY[locale];
  const id = useId();
  return <div className="er-agent-work">
    <section className="er-agent-work__section" aria-labelledby={`${id}-agents`}>
      <div className="er-agent-work__head">
        <h3 id={`${id}-agents`}>{text.agents}</h3>
        {onManageAgents ? <button type="button" className="er-agent-work__link" onClick={onManageAgents}>{text.manageAgents}</button> : null}
      </div>
      {/* An unread list claims nothing; only a read, empty list invites connecting an agent. */}
      {!agentsUnavailable && agents.length === 0 ? <p className="er-agent-work__empty">{text.noAgents}</p> : null}
      <ul className="er-agent-work__agents">{(agentsUnavailable ? [] : agents).map(agent => <li key={agent.id} className="er-agent-chip"
        data-connection-state={agent.connectionState} data-presence={agent.presence}
        title={`${agent.name} · ${text.connectionState[agent.connectionState]} · ${text.transport[agent.transport]} · ${text.presence[agent.presence]}`}>
        <span className="er-agent-chip__dot" aria-hidden="true" />
        <span className="er-agent-chip__name">{agent.name}</span>
        <span className="er-agent-chip__meta">{agent.presence === "unknown" ? text.connectionState[agent.connectionState]
          : `${text.connectionState[agent.connectionState]} · ${text.presence[agent.presence]}`}</span>
      </li>)}</ul>
      {onMoreAgents || onFirstAgents ? <div className="er-agent-work__head">
        {onFirstAgents ? <button type="button" className="er-agent-work__link" onClick={onFirstAgents}>{text.firstAgents}</button> : null}
        {onMoreAgents ? <button type="button" className="er-agent-work__link" onClick={onMoreAgents}>{text.moreAgents}</button> : null}
      </div> : null}
      {assign}
    </section>

    {tools.length === 0 ? null : <section className="er-agent-work__section" aria-labelledby={`${id}-tools`}>
      <h3 id={`${id}-tools`}>{text.tools}</h3>
      <ul className="er-agent-work__tools">{tools.map(tool => <li key={tool}>
        <button type="button" className="er-agent-tool" data-accent={TOOL_ACCENT[tool]} onClick={() => onTool(tool)}
          title={text.tool[tool].hint} aria-describedby={`${id}-${tool}`}>
          <span className="er-agent-tool__glyph"><MaterialSymbol name={TOOL_ICON[tool]} /></span>
          <span className="er-agent-tool__text">
            <span className="er-agent-tool__label">{text.tool[tool].label}</span>
            <span className="er-agent-tool__hint" id={`${id}-${tool}`} aria-hidden="true">{text.tool[tool].hint}</span>
          </span>
        </button>
      </li>)}</ul>
    </section>}

    {/* Unread tasks claim nothing, so the section waits until tasks are read. */}
    {tasksUnavailable ? null : <section className="er-agent-work__section" aria-labelledby={`${id}-tasks`}>
      <h3 id={`${id}-tasks`}>{text.tasks}</h3>
      {tasksUnavailable || tasks.length === 0 ? <p className="er-agent-work__empty">{tasksUnavailable ? text.tasksUnavailable : text.noTasks}</p> : <ul className="er-agent-work__tasks">
        {tasks.map(task => {
          const state = text.taskState(task.state, task.progress);
          const body = <>
            <span className="er-agent-task__glyph"><MaterialSymbol name={task.state === "done" ? "task-done" : task.state === "waiting" ? "pending" : task.tool ? TOOL_ICON[task.tool] : "agent"} /></span>
            <span className="er-agent-task__text">
              <span className="er-agent-task__title">{task.title}</span>
              <span className="er-agent-task__meta">{task.agent} · {state}</span>
            </span>
            {task.state === "working" && task.progress ? <progress className="er-agent-task__progress" max={task.progress.total} value={task.progress.done} aria-label={state} /> : null}
          </>;
          return <li key={task.id} className="er-agent-task" data-state={task.state}>
            {onTask ? <button type="button" className="er-agent-task__open" onClick={() => onTask(task.id)}>{body}</button> : <div className="er-agent-task__open">{body}</div>}
          </li>;
        })}
      </ul>}
      {!tasksUnavailable && (onMoreTasks || onFirstTasks) ? <div className="er-agent-work__head">
        {onFirstTasks ? <button type="button" className="er-agent-work__link" onClick={onFirstTasks}>{text.firstTasks}</button> : null}
        {onMoreTasks ? <button type="button" className="er-agent-work__link" onClick={onMoreTasks}>{text.moreTasks}</button> : null}
      </div> : null}
    </section>}
  </div>;
}
