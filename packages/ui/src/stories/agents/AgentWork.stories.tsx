import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { AgentWorkPane } from "../../features/agents/AgentWorkPane";
import { HandoffSheet } from "../../features/agents/HandoffSheet";
import { DecisionInbox } from "../../features/agents/DecisionInbox";
import type { AgentSummary, AgentTaskSummary, DecisionItem, ResearchToolId, TaskScope } from "../../features/agents/agent-work-model";
import "./agent-stories.css";

/* Fixture shapes only; the live workspace reads protected connections through the owner client. */
const AGENTS: readonly AgentSummary[] = [
  { id: "codex", name: "Codex", transport: "mcp", connectionState: "owner-enabled", presence: "unknown" },
  { id: "claude-code", name: "Claude Code", transport: "local", connectionState: "owner-enabled", presence: "unknown" },
  { id: "spark", name: "Gemini Spark", transport: "inbox", connectionState: "disabled", presence: "unknown" },
];
const TOOLS: readonly ResearchToolId[] = ["verify", "mentions", "search", "deep", "overview", "versions", "changes", "document", "wiki", "import", "erase"];
const TASKS: readonly AgentTaskSummary[] = [
  { id: "t1", title: "Check three claims in section 2", agent: "Codex", tool: "verify", state: "decision" },
  { id: "t2", title: "All mentions of the camp map", agent: "Claude Code", tool: "mentions", state: "working", progress: { done: 2, total: 4 } },
  { id: "t3", title: "Overview of the new archive", agent: "Codex", tool: "overview", state: "waiting" },
  { id: "t4", title: "What changed since Monday", agent: "Eliot", tool: "changes", state: "done" },
];
const SCOPE: readonly TaskScope[] = [
  { id: "section-2", kind: "section", label: "2. Versions of the cause" },
  { id: "source-protocol", kind: "source", label: "Protocol 1959.docx" },
];
const DECISIONS: readonly DecisionItem[] = [
  { id: "d-doc", kind: "document", risk: "D2", title: "Save “Check of section 2” as a document", from: "Codex", project: "Dyatlov Pass", detail: "Two claims supported, one contradicted by the protocol of 26 Feb." },
  { id: "d-del", kind: "delete", risk: "D3", title: "Delete “Draft.md” versions", from: "Codex", project: "Dyatlov Pass", detail: "Duplicate of the protocol; its 2 versions are not cited anywhere." },
  { id: "d-src", kind: "sources", risk: "D1", title: "Add 2 sources: regional archive, newspaper 1959", from: "Claude Code", project: "Dyatlov Pass" },
];

const meta = {
  title: "Product/Agents",
  decorators: [(Story) => <div className="eliot-token-story"><Story /></div>],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const pane = (locale: "en" | "ru", onTool = fn(), onTask = fn()) =>
  <div className="er-agent-story-pane"><AgentWorkPane locale={locale} agents={AGENTS} tools={TOOLS} tasks={TASKS} onTool={onTool} onTask={onTask} onManageAgents={fn()} /></div>;

export const ControlPane: Story = {
  render: () => pane("en"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Check a claim" })).toBeVisible();
    await expect(canvas.getByText("Needs your decision", { exact: false })).toBeVisible();
    await expect(canvas.getByText("Working · 2 of 4", { exact: false })).toBeVisible();
    await expect(canvas.getByRole("progressbar")).toHaveAttribute("value", "2");
  },
};

export const ConfiguredPresenceUnknown: Story = {
  render: () => <div className="er-agent-story-pane"><AgentWorkPane locale="en"
    agents={[{ id: "configured", name: "Configured agent", transport: "mcp", connectionState: "owner-enabled", presence: "unknown" },
      { id: "disabled", name: "Disabled agent", transport: "inbox", connectionState: "disabled", presence: "unknown" },
      { id: "observed", name: "Observed ready fixture", transport: "mcp", connectionState: "owner-enabled", presence: "ready" }]}
    tools={["versions"]} tasks={[]} onTool={fn()} onMoreAgents={fn()} onManageAgents={fn()} /></div>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Enabled · Presence not checked")).toBeVisible();
    await expect(canvas.getByText("Disabled · Presence not checked")).toBeVisible();
    await expect(canvas.queryByText("Ready", { exact: true })).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "More connections" })).toBeVisible();
    const dot = canvasElement.querySelector<HTMLElement>('[data-presence="unknown"] .er-agent-chip__dot');
    if (dot === null) throw new Error("Unknown connection needs its status marker");
    const ready = canvasElement.querySelector<HTMLElement>('[data-presence="ready"] .er-agent-chip__dot');
    if (ready === null) throw new Error("Ready fixture needs its comparison marker");
    if (getComputedStyle(dot).backgroundColor === getComputedStyle(ready).backgroundColor) throw new Error("Unverified presence looked ready");
  },
};

export const ControlPaneRussianDark: Story = {
  render: () => <div data-theme="dark" className="eliot-token-story">{pane("ru")}</div>,
};

export const UnreadTasks: Story = {
  render: () => <div className="er-agent-story-pane"><AgentWorkPane locale="en" agents={[]}
    tools={[]} tasks={[{ id: "private-stale", title: "Private stale task", agent: "Agent", state: "done" }]}
    tasksUnavailable onTool={fn()} onMoreTasks={fn()} /></div>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Tasks have not been read for this project.")).toBeVisible();
    await expect(canvas.queryByText("Private stale task")).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "More tasks" })).not.toBeInTheDocument();
  },
};

export const AcceptedDispatchIsNotCompletion: Story = {
  render: () => <div className="er-agent-story-pane"><AgentWorkPane locale="en" agents={[]}
    tools={[]} tasks={[{ id: "accepted", title: "Accepted research request", agent: "Agent", state: "accepted" }]}
    onTool={fn()} onMoreTasks={fn()} onFirstTasks={fn()} /></div>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Agent · Accepted by the agent; run status not checked")).toBeVisible();
    await expect(canvas.queryByText("Done", { exact: true })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("progressbar")).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "More tasks" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "First tasks" })).toBeVisible();
  },
};

const sent = fn();
export const HandOverAClaimCheck: Story = {
  render: () => <HandoffSheet locale="en" open agents={AGENTS} tools={TOOLS} scope={SCOPE} initialTool="verify" onSend={sent} onClose={fn()} />,
  play: async ({ canvasElement }) => {
    sent.mockClear();
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog", { name: "Hand over" });
    const sheet = within(dialog);
    await expect(sheet.getByRole("radio", { name: /Gemini Spark.*Disabled.*Presence not checked/ })).toBeDisabled();
    await expect(sheet.getByRole("radio", { name: /Codex.*Enabled.*Presence not checked/ })).toBeEnabled();
    await userEvent.click(sheet.getByRole("button", { name: "Remove Protocol 1959.docx" }));
    await expect(sheet.queryByText("Protocol 1959.docx")).toBeNull();
    await expect(sheet.getByText("Codex · Check a claim: 2. Versions of the cause.")).toBeVisible();
    await userEvent.click(sheet.getByRole("radio", { name: "Delete versions" }));
    await expect(sheet.getByText("Deletion happens only after you confirm it in the Inbox.", { exact: false })).toBeVisible();
    await userEvent.click(sheet.getByRole("radio", { name: "Check a claim" }));
    await userEvent.type(sheet.getByRole("textbox"), "Start with 1–2 February");
    await userEvent.click(sheet.getByRole("button", { name: "Send" }));
    await expect(sent).toHaveBeenCalledWith({ target: "codex", tool: "verify", scope: [SCOPE[0]], note: "Start with 1–2 February" });
  },
};

export const YourRequestNeedsWords: Story = {
  render: () => <HandoffSheet locale="ru" open agents={AGENTS} tools={TOOLS} scope={SCOPE} initialTool="request" onSend={fn()} onClose={fn()} />,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const sheet = within(await body.findByRole("dialog", { name: "Поручение" }));
    await userEvent.click(sheet.getByRole("button", { name: "Отправить" }));
    await expect(sheet.getByRole("alert")).toHaveTextContent("Сначала опишите запрос.");
    await userEvent.type(sheet.getByRole("textbox"), "Сверь даты с протоколом");
    await expect(sheet.queryByRole("alert")).toBeNull();
  },
};

export const OwnerDecisions: Story = {
  render: function Render() {
    const onDecide = fn();
    return <div className="er-agent-story-wide"><DecisionInbox locale="en" items={DECISIONS} onDecide={onDecide} onOpen={fn()} /></div>;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const items = canvas.getAllByRole("listitem");
    const first = items[0];
    if (first === undefined) throw new Error("Decision Inbox must render its owner-only item");
    // Owner-only work comes first: the deletion leads the list and names its own action.
    await expect(first).toHaveTextContent("Delete “Draft.md” versions");
    await expect(within(first).getByRole("button", { name: "Delete" })).toBeVisible();
    await expect(within(first).getByRole("button", { name: "Keep" })).toBeVisible();
    await expect(canvas.getByText("3")).toBeVisible();
  },
};

export const OwnerDecisionsRussianDark: Story = {
  render: () => <div data-theme="dark" className="eliot-token-story er-agent-story-wide">
    <DecisionInbox locale="ru" items={DECISIONS.map(item => ({ ...item, title: item.kind === "delete" ? "Удалить версии «Черновик.md»" : item.kind === "document" ? "Сохранить «Проверка раздела 2» как документ" : "Добавить 2 источника: областной архив, газета 1959", project: "Перевал Дятлова", detail: undefined }))}
      onDecide={fn()} pending={["d-src"]} />
  </div>,
};

export const NothingWaiting: Story = {
  render: () => <div className="er-agent-story-pane">
    <AgentWorkPane locale="en" agents={AGENTS.slice(0, 1)} tools={TOOLS.slice(0, 4)} tasks={[]} onTool={fn()} />
    <DecisionInbox locale="en" items={[]} onDecide={fn()} />
  </div>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Tasks you hand over appear here.")).toBeVisible();
    await expect(canvas.getByText("Nothing is waiting for you.")).toBeVisible();
  },
};
