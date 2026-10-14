import { useId, useState } from "react";
import { Button, Dialog } from "../../primitives/primitives";
import { MaterialSymbol } from "../../catalog/MaterialSymbol";
import {
  AGENT_WORK_COPY, TOOL_ICON,
  type AgentSummary, type AgentWorkLocale, type HandoffRequest, type ResearchToolId, type TaskScope,
} from "./agent-work-model";
import "./agents.css";

export interface HandoffSheetProps {
  readonly locale: AgentWorkLocale;
  readonly open: boolean;
  readonly agents: readonly AgentSummary[];
  /** The system's tools for this project; "Your request" is always offered for anything else. */
  readonly tools: readonly ResearchToolId[];
  /** What the owner selected before opening the sheet: a section, a claim, sources or the research. */
  readonly scope: readonly TaskScope[];
  readonly initialTool?: ResearchToolId | "request" | undefined;
  readonly initialTarget?: string | undefined;
  readonly onSend: (request: HandoffRequest) => void;
  readonly onClose: () => void;
}

/**
 * One task sheet: To · Tool · What · Notes, then a sentence that says exactly what will happen.
 * Remounts per opening, so a closed sheet never carries a half-written task into the next one.
 */
export function HandoffSheet(props: HandoffSheetProps) {
  const text = AGENT_WORK_COPY[props.locale].sheet;
  return <Dialog open={props.open} title={text.title} onClose={props.onClose}>
    {props.open ? <HandoffForm {...props} /> : null}
  </Dialog>;
}

function HandoffForm({ locale, agents, tools, scope: initialScope, initialTool, initialTarget, onSend, onClose }: HandoffSheetProps) {
  const copy = AGENT_WORK_COPY[locale];
  const text = copy.sheet;
  const id = useId();
  const firstReady = agents.find(agent => agent.presence !== "offline")?.id ?? "eliot";
  const [target, setTarget] = useState(initialTarget ?? firstReady);
  const [tool, setTool] = useState<ResearchToolId | "request">(initialTool ?? tools[0] ?? "request");
  const [scope, setScope] = useState<readonly TaskScope[]>(initialScope);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<"note" | "scope" | null>(null);
  const targetName = target === "eliot" ? text.system : agents.find(agent => agent.id === target)?.name ?? text.system;
  const toolLabel = copy.tool[tool].label;
  const items = scope.map(item => item.label).join(", ");

  const send = () => {
    if (scope.length === 0) { setProblem("scope"); return; }
    if (tool === "request" && note.trim().length === 0) { setProblem("note"); return; }
    onSend({ target, tool, scope, note: note.trim() });
  };

  return <form className="er-handoff" onSubmit={event => { event.preventDefault(); send(); }}>
    <fieldset className="er-handoff__group">
      <legend>{text.to}</legend>
      <div className="er-chip-row">
        <label className="er-chip"><input type="radio" name={`${id}-to`} checked={target === "eliot"} onChange={() => setTarget("eliot")} />
          <MaterialSymbol name="spark" /><span>{text.system}</span></label>
        {agents.map(agent => <label key={agent.id} className="er-chip" data-presence={agent.presence}>
          <input type="radio" name={`${id}-to`} checked={target === agent.id} disabled={agent.presence === "offline"} onChange={() => setTarget(agent.id)} />
          <MaterialSymbol name="agent" /><span>{agent.name}</span>{agent.presence === "offline" ? <span className="er-chip__meta">{text.offline}</span> : null}
        </label>)}
      </div>
    </fieldset>

    <fieldset className="er-handoff__group">
      <legend>{text.tool}</legend>
      <div className="er-chip-row">
        {[...tools, "request" as const].map(option => <label key={option} className="er-chip" title={copy.tool[option].hint}>
          <input type="radio" name={`${id}-tool`} checked={tool === option} onChange={() => { setTool(option); if (problem === "note") setProblem(null); }} />
          <MaterialSymbol name={TOOL_ICON[option]} /><span>{copy.tool[option].label}</span>
        </label>)}
      </div>
      <p className="er-handoff__hint">{copy.tool[tool].hint}</p>
    </fieldset>

    <fieldset className="er-handoff__group">
      <legend>{text.what}</legend>
      {scope.length > 0 ? <ul className="er-chip-row" aria-label={text.what}>{scope.map(item => <li key={item.id} className="er-chip er-chip--input">
        <span className="er-chip__kind">{copy.scopeKind[item.kind]}</span><span>{item.label}</span>
        <button type="button" className="er-chip__remove" aria-label={text.remove(item.label)}
          onClick={() => setScope(old => old.filter(entry => entry.id !== item.id))}><MaterialSymbol name="close" /></button>
      </li>)}</ul> : null}
      {problem === "scope" ? <p className="er-handoff__problem" role="alert">{text.scopeRequired}</p> : null}
    </fieldset>

    <label className="er-handoff__note">
      <span>{text.note}</span>
      <textarea rows={2} value={note} placeholder={text.notePlaceholder} aria-invalid={problem === "note"}
        onChange={event => { setNote(event.target.value); if (problem === "note") setProblem(null); }} />
    </label>
    {problem === "note" ? <p className="er-handoff__problem" role="alert">{text.noteRequired}</p> : null}

    <p className="er-handoff__summary">
      <MaterialSymbol name={target === "eliot" ? "spark" : "agent"} />
      <span>{text.summary(targetName, toolLabel, items || "—")}{tool === "erase" ? ` ${text.eraseNote}` : ""}</span>
    </p>

    <div className="er-handoff__actions">
      <Button variant="text" type="button" onClick={onClose}>{text.cancel}</Button>
      <Button variant="primary" type="submit" icon="send">{text.send}</Button>
    </div>
  </form>;
}
