import { useId } from "react";
import { Button } from "../../primitives/primitives";
import { MaterialSymbol } from "../../catalog/MaterialSymbol";
import {
  AGENT_WORK_COPY, DECISION_ICON,
  type AgentWorkLocale, type DecisionItem, type DecisionRisk,
} from "./agent-work-model";
import "./agents.css";

export interface DecisionInboxProps {
  readonly locale: AgentWorkLocale;
  /** Proposals the policy could not promote on its own: D2 after a verifier, D3 for the owner only. */
  readonly items: readonly DecisionItem[];
  /** Absent until the decision mutations exist: the inbox then offers only "Open". */
  readonly onDecide?: ((itemId: string, decision: "accept" | "decline") => void) | undefined;
  readonly onOpen?: ((itemId: string) => void) | undefined;
  readonly openLabel?: string | undefined;
  /** Item ids whose decision is being written; their actions stay put but cannot be pressed twice. */
  readonly pending?: readonly string[] | undefined;
}

const ORDER: Record<DecisionRisk, number> = { D3: 0, D2: 1, D1: 2, D0: 3 };

/**
 * The owner's Draft Inbox: what agents propose and only a person may decide. Authority-sensitive
 * items come first; a deletion reads as one, with its own words on both buttons.
 */
export function DecisionInbox({ locale, items, onDecide, onOpen, openLabel, pending = [] }: DecisionInboxProps) {
  const text = AGENT_WORK_COPY[locale].inbox;
  const id = useId();
  const ordered = [...items].sort((left, right) => ORDER[left.risk] - ORDER[right.risk]);
  return <section className="er-inbox" aria-labelledby={`${id}-title`}>
    <div className="er-inbox__head">
      <h3 id={`${id}-title`}>{text.title}</h3>
      {items.length > 0 ? <span className="er-inbox__count">{items.length}</span> : null}
    </div>
    {ordered.length === 0 ? <p className="er-inbox__empty"><MaterialSymbol name="task-done" /><span>{text.empty}</span></p> : <ul className="er-inbox__list">
      {ordered.map(item => {
        const busy = pending.includes(item.id);
        const destructive = item.kind === "delete";
        return <li key={item.id} className="er-inbox__item" data-risk={item.risk} data-kind={item.kind}>
          <span className="er-inbox__glyph"><MaterialSymbol name={DECISION_ICON[item.kind]} /></span>
          <div className="er-inbox__body">
            <p className="er-inbox__title">{item.title}</p>
            <p className="er-inbox__meta">
              <span className="er-inbox__risk">{text.risk[item.risk]}</span>
              {item.from || item.project ? <span>{[item.from ? text.from(item.from) : "", item.project ?? ""].filter(Boolean).join(" · ")}</span> : null}
            </p>
            {item.detail ? <p className="er-inbox__detail">{item.detail}</p> : null}
          </div>
          <div className="er-inbox__actions">
            {onOpen ? <Button variant={onDecide ? "text" : "tonal"} onClick={() => onOpen(item.id)}>{openLabel ?? text.open}</Button> : null}
            {onDecide ? <>
              <Button variant="text" disabled={busy} onClick={() => onDecide(item.id, "decline")}>{destructive ? text.keep : text.decline}</Button>
              <Button variant="tonal" {...(destructive ? { className: "er-inbox__destructive" } : {})} disabled={busy}
                onClick={() => onDecide(item.id, "accept")}>{destructive ? text.delete : text.accept}</Button>
            </> : null}
          </div>
        </li>;
      })}
    </ul>}
  </section>;
}
