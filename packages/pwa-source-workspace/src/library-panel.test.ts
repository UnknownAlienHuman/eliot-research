import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "./api.js";
import { readLibraryPage, type LibraryPage } from "./library-api.js";
import { mountLibraryPanel } from "./library-panel.js";

vi.mock("./library-api.js", () => ({ readLibraryPage: vi.fn() }));

class FakeElement {
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  disabled = false;
  type = "";
  className = "";
  onclick: (() => void) | null = null;
  private content = "";
  private markup = "";

  public constructor(private readonly selectors: ReadonlyMap<string, FakeElement> = new Map()) {}

  public set textContent(value: string) { this.content = value; this.children.length = 0; }
  public get textContent(): string { return this.content + this.children.map((child) => child.textContent).join(""); }
  public set innerHTML(value: string) { this.markup = value; this.children.length = 0; }
  public get innerHTML(): string { return this.markup; }

  public querySelector<T extends FakeElement>(selector: string): T | null {
    const direct = this.selectors.get(selector);
    if (direct !== undefined) return direct as T;
    if (selector === "[data-library-retry]") {
      return this.children.flatMap((child) => [child, ...child.children])
        .find((child) => child.dataset.libraryRetry === "true") as T | undefined ?? null;
    }
    return null;
  }

  public querySelectorAll<T extends FakeElement>(_selector: string): T[] { return []; }
  public replaceChildren(...children: FakeElement[]): void { this.children.splice(0, this.children.length, ...children); }
  public append(...children: FakeElement[]): void { this.children.push(...children); }
  public dispatchEvent(_event: unknown): boolean { return true; }
  public click(): void { this.onclick?.(); }
}

function fakeLibraryDom(): { readonly root: FakeElement; readonly status: FakeElement } {
  const selectors = new Map<string, FakeElement>([
    ["[data-first]", new FakeElement()],
    ["[data-next]", new FakeElement()],
    ["[data-scope]", new FakeElement()],
    ['[role="status"]', new FakeElement()],
    ["[data-library-result]", new FakeElement()],
    ["[data-library-versions]", new FakeElement()],
    ["[data-library-readiness]", new FakeElement()],
  ]);
  vi.stubGlobal("document", { createElement: () => new FakeElement() });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("CustomEvent", class { public constructor(public readonly type: string, public readonly init?: unknown) {} });
  return { root: new FakeElement(selectors), status: selectors.get('[role="status"]') as FakeElement };
}

function page(projects: LibraryPage["projects"], sources: LibraryPage["sources"] = []): LibraryPage {
  return { projects, sources, generation: "deployment-1", trace: "trace-1" };
}

async function flushPanelWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(readLibraryPage).mockReset();
});

describe("Library panel catalog recovery", () => {
  it("offers one explicit same-project reload from page one after an authority conflict", async () => {
    vi.mocked(readLibraryPage)
      .mockResolvedValueOnce(page([]))
      .mockRejectedValueOnce(new ApiRequestError({
        status: 409,
        code: "CATALOG_AUTHORITY_CHANGED",
        message: "Catalog changed while reading; reload",
        retryable: true,
      }))
      .mockResolvedValueOnce(page(
        [{ id: "project-1", title: "Project one", generation: "project-generation-1" }],
        [{ id: "source-1", title: "Source one", readiness_ref: "readiness:source-1:revision-1" }],
      ));

    const { root, status } = fakeLibraryDom();
    const library = mountLibraryPanel(root as unknown as HTMLElement, vi.fn());
    await flushPanelWork();
    expect(readLibraryPage).toHaveBeenNthCalledWith(1, {}, expect.any(AbortSignal));

    library.openProject("project-1");
    expect(readLibraryPage).toHaveBeenNthCalledWith(2, { project: "project-1" }, expect.any(AbortSignal));
    await flushPanelWork();

    expect(readLibraryPage).toHaveBeenCalledTimes(2);
    const retry = status.querySelector<FakeElement>("[data-library-retry]");
    expect(retry?.textContent).toBe("Reload catalog from first page");
    expect(status.textContent).toContain("temporarily unavailable");

    retry?.click();
    await flushPanelWork();

    expect(readLibraryPage).toHaveBeenCalledTimes(3);
    expect(readLibraryPage).toHaveBeenNthCalledWith(3, { project: "project-1" }, expect.any(AbortSignal));
    expect(status.textContent).toContain("1 source on this page.");
    library();
  });
});
