import { useId, useState } from "react";
import { MaterialSymbol } from "../../catalog/MaterialSymbol";
import type { AgentWorkLocale } from "./agent-work-model";
import "./agents.css";

export type AgentClientId = "codex" | "claude-code" | "other";

export interface AgentConnectGuideProps {
  readonly locale: AgentWorkLocale;
  /** The service's MCP endpoint as the server publishes it; absent until the server says it. */
  readonly mcpUrl?: string | undefined;
  /** The server name agents register; one stable word. */
  readonly serverName?: string | undefined;
}

const COPY = {
  en: {
    title: "Connect an agent",
    lead: "Agents connect over MCP. Add this address to your agent and sign in once — it then appears in the list below and can take tasks.",
    address: "Service address",
    pending: "The server has not published its MCP address yet.",
    copy: "Copy",
    copied: "Copied",
    clients: "Agent",
    other: "Other agent",
    steps: {
      codex: "Run in a terminal, then sign in in the browser window that opens:",
      "claude-code": "Run in a terminal, then type /mcp in Claude Code and sign in:",
      other: "In your agent's MCP settings, add a remote server (Streamable HTTP) with this address and sign in with OAuth.",
    },
  },
  ru: {
    title: "Подключить агента",
    lead: "Агенты подключаются по MCP. Добавьте этот адрес в своего агента и один раз войдите — он появится в списке ниже и сможет брать поручения.",
    address: "Адрес сервиса",
    pending: "Сервер ещё не опубликовал свой MCP-адрес.",
    copy: "Копировать",
    copied: "Скопировано",
    clients: "Агент",
    other: "Другой агент",
    steps: {
      codex: "Выполните в терминале и войдите в открывшемся окне браузера:",
      "claude-code": "Выполните в терминале, затем наберите /mcp в Claude Code и войдите:",
      other: "В настройках MCP вашего агента добавьте удалённый сервер (Streamable HTTP) с этим адресом и войдите через OAuth.",
    },
  },
} as const;

const PLACEHOLDER = "—";

function commandFor(client: AgentClientId, url: string, name: string): string | undefined {
  if (client === "codex") return `codex mcp add ${name} --url ${url}\ncodex mcp login ${name}`;
  if (client === "claude-code") return `claude mcp add --transport http ${name} ${url}`;
  return undefined;
}

/**
 * How an agent joins: the one address it needs, and the exact command for the clients the owner uses.
 * The agent signs in itself through the service's OAuth; no secret is shown or typed here.
 */
export function AgentConnectGuide({ locale, mcpUrl, serverName = "eliot-research" }: AgentConnectGuideProps) {
  const text = COPY[locale];
  const id = useId();
  const [client, setClient] = useState<AgentClientId>("codex");
  const [copied, setCopied] = useState<string>();
  const url = mcpUrl ?? PLACEHOLDER;
  const command = commandFor(client, url, serverName);
  const copy = (value: string, key: string) => {
    if (mcpUrl === undefined) return;
    void navigator.clipboard?.writeText(value).then(() => setCopied(key), () => setCopied(undefined));
  };
  return <section className="er-agent-connect" aria-labelledby={`${id}-title`}>
    <header className="er-agent-connect__head">
      <span className="er-agent-connect__glyph" aria-hidden="true"><MaterialSymbol name="agent" /></span>
      <h2 id={`${id}-title`}>{text.title}</h2>
    </header>
    <p className="er-agent-connect__lead">{text.lead}</p>
    <div className="er-agent-connect__field">
      <span className="er-agent-connect__label" id={`${id}-address`}>{text.address}</span>
      <div className="er-agent-connect__value" data-pending={mcpUrl === undefined ? "true" : "false"}>
        <code>{url}</code>
        <button type="button" className="er-agent-connect__copy" disabled={mcpUrl === undefined}
          aria-label={`${text.copy}: ${text.address}`} onClick={() => copy(url, "url")}>
          <MaterialSymbol name={copied === "url" ? "check" : "copy"} /><span>{copied === "url" ? text.copied : text.copy}</span>
        </button>
      </div>
      {mcpUrl === undefined ? <p className="er-agent-connect__note">{text.pending}</p> : null}
    </div>
    <fieldset className="er-agent-connect__clients">
      <legend>{text.clients}</legend>
      <div className="er-chip-row">
        {(["codex", "claude-code", "other"] as const).map(option => <label key={option} className="er-chip">
          <input type="radio" name={`${id}-client`} checked={client === option} onChange={() => { setClient(option); setCopied(undefined); }} />
          <MaterialSymbol name={option === "other" ? "link" : "terminal"} />
          <span>{option === "codex" ? "Codex" : option === "claude-code" ? "Claude Code" : text.other}</span>
        </label>)}
      </div>
    </fieldset>
    <p className="er-agent-connect__step">{text.steps[client]}</p>
    {command !== undefined ? <div className="er-agent-connect__value er-agent-connect__value--command" data-pending={mcpUrl === undefined ? "true" : "false"}>
      <pre><code>{command}</code></pre>
      <button type="button" className="er-agent-connect__copy" disabled={mcpUrl === undefined}
        aria-label={`${text.copy}: ${client === "codex" ? "Codex" : "Claude Code"}`} onClick={() => copy(command, client)}>
        <MaterialSymbol name={copied === client ? "check" : "copy"} /><span>{copied === client ? text.copied : text.copy}</span>
      </button>
    </div> : null}
  </section>;
}
