import { useId } from "react";
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
  readonly onTool: (tool: ResearchToolId) => void;
  readonly onTask?: ((taskId: string) => void) | undefined;
  readonly onManageAgents?: (() => void) | undefined;
}

/**
 * The right pane of a project, as NotebookLM's Studio: who is connected, the system's tools and the
 * tasks handed over. Presentation only — the owner of the workspace decides what each callback does.
 */
export function AgentWorkPane({ locale, agents, agentsUnavailable = false, tools, tasks, onTool, onTask, onManageAgents }: AgentWorkPaneProps) {
  const text = AGENT_WORK_COPY[locale];
  const id = useId();
  return <div className="er-agent-work">
    <section className="er-agent-work__section" aria-labelledby={`${id}-agents`}>
      <div className="er-agent-work__head">
        <h3 id={`${id}-agents`}>{text.agents}</h3>
        {onManageAgents ? <button type="button" className="er-agent-work__link" onClick={onManageAgents}>{text.manageAgents}</button> : null}
      </div>
      {agentsUnavailable || agents.length === 0 ? <p className="er-agent-work__empty">{agentsUnavailable ? text.agentsUnavailable : text.noAgents}</p> : null}
      <ul className="er-agent-work__agents">{(agentsUnavailable ? [] : agents).map(agent => <li key={agent.id} className="er-agent-chip" data-presence={agent.presence}
        title={`${agent.name} · ${text.transport[agent.transport]} · ${text.presence[agent.presence]}`}>
        <span className="er-agent-chip__dot" aria-hidden="true" />
        <span className="er-agent-chip__name">{agent.name}</span>
        <span className="er-agent-chip__meta">{agent.presence === "offline" ? text.presence.offline : text.transport[agent.transport]}</span>
      </li>)}</ul>
    </section>

    <section className="er-agent-work__section" aria-labelledby={`${id}-tools`}>
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
    </section>

    <section className="er-agent-work__section" aria-labelledby={`${id}-tasks`}>
      <h3 id={`${id}-tasks`}>{text.tasks}</h3>
      {tasks.length === 0 ? <p className="er-agent-work__empty">{text.noTasks}</p> : <ul className="er-agent-work__tasks">
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
    </section>
  </div>;
}
