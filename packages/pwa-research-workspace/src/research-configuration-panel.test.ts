import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mountResearchConfigurationPanel,
  NO_PROJECT_RESEARCH_COPY,
  NO_PROJECT_RESEARCH_START_STATE,
  type ResearchConfigurationStartState,
} from "./research-configuration-panel.js";
import type { ReadResearchConfigurationOptions, ResearchConfigurationView } from "./research-configuration-api.js";

const mocks = vi.hoisted(() => {
  const child = Object.assign(() => undefined, {
    clearPrivate: vi.fn(),
    refresh: vi.fn(),
  });
  return {
    readReadiness: vi.fn(),
    child,
    mountChild: vi.fn(() => child),
  };
});

vi.mock("./research-configuration-api.js", () => ({ readResearchConfiguration: mocks.readReadiness }));
vi.mock("./research-model-configuration-panel.js", () => ({
  mountResearchModelConfigurationPanel: mocks.mountChild,
  RESEARCH_MODEL_SELECTION_SAVED_EVENT: "eliotr:research-model-selection-saved",
}));

class TestElement extends EventTarget {
  textContent = "";
  innerHTML = "";
  className = "";
  hidden = false;
  disabled = false;

  constructor(private readonly selectors = new Map<string, TestElement>()) { super(); }

  querySelector<T extends Element>(selector: string): T | null {
    return (this.selectors.get(selector) as unknown as T | undefined) ?? null;
  }

  replaceChildren(..._children: unknown[]): void {}
  append(..._children: unknown[]): void {}
}

class TestDocument extends EventTarget {
  createElement(): TestElement { return new TestElement(); }
}

type PendingRead = {
  readonly projectId: string;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (view: ResearchConfigurationView) => void;
};

function makePanelElement(): { readonly root: TestElement; readonly modelHost: TestElement } {
  const modelHost = new TestElement();
  const elements = new Map<string, TestElement>([
    ["[data-research-configuration-badge]", new TestElement()],
    ["[data-research-configuration-summary]", new TestElement()],
    ["[data-research-configuration-explanation]", new TestElement()],
    ["[data-research-configuration-facts]", new TestElement()],
    ["[data-research-configuration-state]", new TestElement()],
    ["[data-research-model-transport]", new TestElement()],
    ["[data-research-run-readiness]", new TestElement()],
    ["[data-research-qualification-state]", new TestElement()],
    ["[data-research-model-route]", new TestElement()],
    ["[data-research-qualification-expires]", new TestElement()],
    ["[data-research-configuration-checked]", new TestElement()],
    ["[data-research-configuration-details]", new TestElement()],
    ["[data-research-configuration-detail-content]", new TestElement()],
    ["[data-research-configuration-refresh]", new TestElement()],
    ["[data-research-model-configuration-host]", modelHost],
  ]);
  return { root: new TestElement(elements), modelHost };
}

function readinessView(overrides: Partial<ResearchConfigurationView> = {}): ResearchConfigurationView {
  return {
    protocol: "eliotr.research-configuration-readiness.v1",
    configuration: "present",
    model_transport: "available",
    qualification_state: "current",
    run_readiness: "ready",
    readiness_reason: "QUALIFICATION_PROOFS_CURRENT",
    model_route: "route/research",
    qualification_expires_at: null,
    missing_fields: [],
    invalid_fields: [],
    checked_at: "2026-10-03T12:00:00.000Z",
    trace_id: "trace-1",
    deployment_generation: "deploy-1",
    ...overrides,
  };
}

function dispatchScope(projectId?: string): void {
  const event = new Event("library:scope-changed");
  Object.defineProperty(event, "detail", { value: { reason: "project-filter", projectId, title: projectId } });
  document.dispatchEvent(event);
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  mocks.readReadiness.mockReset();
  mocks.mountChild.mockClear();
  mocks.child.clearPrivate.mockClear();
  mocks.child.refresh.mockClear();
  vi.unstubAllGlobals();
});

describe("project-scoped research readiness panel", () => {
  it("blocks new runs without a project and ignores late readiness after scope changes", async () => {
    const testDocument = new TestDocument();
    const testWindow = Object.assign(new EventTarget(), { setTimeout: () => 1, clearTimeout: () => undefined });
    vi.stubGlobal("document", testDocument);
    vi.stubGlobal("window", testWindow);
    vi.stubGlobal("navigator", { onLine: true });

    const pending: PendingRead[] = [];
    mocks.readReadiness.mockImplementation((_generation: string, options: ReadResearchConfigurationOptions) =>
      new Promise<ResearchConfigurationView>((resolve) => {
        pending.push({ projectId: options.projectId ?? "", signal: options.signal, resolve });
      }));
    const { root, modelHost } = makePanelElement();
    const states: Array<ResearchConfigurationStartState | null> = [];
    const unmount = mountResearchConfigurationPanel(root as unknown as HTMLElement, {
      deploymentGeneration: () => "deploy-1",
      onStateChange: (state) => states.push(state),
    });

    expect(states.at(-1)).toEqual(NO_PROJECT_RESEARCH_START_STATE);
    expect(NO_PROJECT_RESEARCH_COPY.summary).toContain("Select a project");
    expect(NO_PROJECT_RESEARCH_COPY.explanation).toContain("Existing runs and saved drafts remain available");
    expect(mocks.readReadiness).not.toHaveBeenCalled();

    dispatchScope("project-a");
    dispatchScope("project-b");
    expect(pending.map((request) => request.projectId)).toEqual(["project-a", "project-b"]);
    expect(pending[0]?.signal?.aborted).toBe(true);

    pending[1]?.resolve(readinessView());
    await flushMicrotasks();
    expect(states.at(-1)?.run_readiness).toBe("ready");

    pending[0]?.resolve(readinessView({ configuration: "missing", run_readiness: "blocked" }));
    await flushMicrotasks();
    expect(states.at(-1)?.run_readiness).toBe("ready");

    modelHost.dispatchEvent(new Event("eliotr:research-model-selection-saved", { bubbles: true }));
    expect(pending[2]?.projectId).toBe("project-b");
    dispatchScope();
    expect(pending[2]?.signal?.aborted).toBe(true);
    expect(pending).toHaveLength(3);
    expect(states.at(-1)).toEqual(NO_PROJECT_RESEARCH_START_STATE);

    pending[2]?.resolve(readinessView());
    await flushMicrotasks();
    expect(states.at(-1)).toEqual(NO_PROJECT_RESEARCH_START_STATE);
    unmount();
  });
});
