const MAX_MARKDOWN_BYTES = 256 * 1024;
const MAX_TREE_NODES = 4096;
const MAX_TREE_DEPTH = 24;
const PARSE_TIMEOUT_MS = 2500;

type InlineNode =
  | { readonly type: "text" | "code" | "image"; readonly text: string }
  | { readonly type: "break" }
  | { readonly type: "emphasis" | "strong" | "strike"; readonly children: readonly InlineNode[] }
  | { readonly type: "link"; readonly href: string; readonly children: readonly InlineNode[] };

type BlockNode =
  | { readonly type: "paragraph" | "blockquote" | "listItem"; readonly children: readonly ReadingNode[] }
  | { readonly type: "table" | "tableHead" | "tableBody" | "tableRow"; readonly children: readonly ReadingNode[] }
  | { readonly type: "tableCell"; readonly header: boolean; readonly children: readonly ReadingNode[] }
  | { readonly type: "heading"; readonly level: number; readonly children: readonly ReadingNode[] }
  | { readonly type: "list"; readonly ordered: boolean; readonly children: readonly ReadingNode[] }
  | { readonly type: "codeBlock"; readonly text: string }
  | { readonly type: "rule" };

type ReadingNode = InlineNode | BlockNode;

interface ParseSuccess {
  readonly type: "reading-markdown-result";
  readonly ok: true;
  readonly nodes: readonly unknown[];
}

interface ParseFailure {
  readonly type: "reading-markdown-result";
  readonly ok: false;
}

interface ActiveRender {
  cancel(): void;
}

const generations = new WeakMap<HTMLElement, number>();
const activeRenders = new WeakMap<HTMLElement, ActiveRender>();

/**
 * Returns a canonical absolute web or mail link. Markdown labels remain visible
 * when their destination is relative or uses a scheme outside this allowlist.
 */
export function getSafeReadingMarkdownHref(value: string): string | null {
  if (value.length === 0 || /[\u0000-\u0020\u007f]/u.test(value)) return null;

  try {
    if (/^https?:\/\//iu.test(value)) {
      const parsed = new URL(value);
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.hostname.length === 0 || parsed.username.length > 0 || parsed.password.length > 0) return null;
      return parsed.href;
    }

    if (/^mailto:/iu.test(value)) {
      const parsed = new URL(value);
      if (parsed.protocol !== "mailto:" || parsed.hostname.length > 0 ||
        parsed.pathname.length === 0 || parsed.pathname.startsWith("//")) return null;
      return parsed.href;
    }
  } catch {
    return null;
  }

  return null;
}

/** Avoid dispatching oversized content to the parser worker. */
export function isWithinReadingMarkdownLimit(text: string): boolean {
  if (text.length > MAX_MARKDOWN_BYTES) return false;
  return new TextEncoder().encode(text).byteLength <= MAX_MARKDOWN_BYTES;
}

/**
 * Render a bounded Markdown reading view using a short-lived parser worker.
 * The original text stays authoritative elsewhere; this function only swaps
 * the presentation after validating the worker's compact node tree.
 */
export function renderReadingMarkdown(
  container: HTMLElement,
  text: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const generation = (generations.get(container) ?? 0) + 1;
  generations.set(container, generation);
  activeRenders.get(container)?.cancel();
  container.textContent = text;
  container.dataset.readingFormat = "plain";

  if (signal?.aborted || !isWithinReadingMarkdownLimit(text)) return Promise.resolve(false);

  let worker: Worker;
  try {
    worker = new Worker(new URL("./reading-markdown.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timeout = 0;

    const isCurrent = (): boolean => generations.get(container) === generation;
    const finish = (success: boolean, nodes?: readonly unknown[]): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      if (activeRenders.get(container)?.cancel === cancel) activeRenders.delete(container);

      let formatted = false;
      if (isCurrent()) {
        if (success && nodes !== undefined) {
          try {
            const fragment = renderTree(nodes);
            if (fragment !== null) {
              container.replaceChildren(fragment);
              container.dataset.readingFormat = "formatted";
              formatted = true;
            }
          } catch {
            formatted = false;
          }
        }
        if (!formatted) { container.textContent = text; container.dataset.readingFormat = "plain"; }
      }
      resolve(formatted);
    };
    const cancel = (): void => finish(false);

    activeRenders.set(container, { cancel });
    signal?.addEventListener("abort", cancel, { once: true });
    timeout = window.setTimeout(cancel, PARSE_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<unknown>): void => {
      const result = readParseResult(event.data);
      if (result === null || !result.ok) finish(false);
      else finish(true, result.nodes);
    };
    worker.onerror = (): void => finish(false);

    try {
      worker.postMessage({ type: "parse-reading-markdown", text });
    } catch {
      finish(false);
    }
  });
}

function readParseResult(value: unknown): ParseSuccess | ParseFailure | null {
  if (!isRecord(value) || value.type !== "reading-markdown-result" || typeof value.ok !== "boolean") return null;
  if (value.ok === false) return Object.keys(value).length === 2 ? { type: value.type, ok: false } : null;
  if (!Array.isArray(value.nodes) || Object.keys(value).length !== 3) return null;
  return { type: value.type, ok: true, nodes: value.nodes };
}

function renderTree(nodes: readonly unknown[]): DocumentFragment | null {
  let count = 0;
  const fragment = document.createDocumentFragment();
  for (const node of nodes) {
    const rendered = renderNode(node, 0, () => {
      count += 1;
      return count <= MAX_TREE_NODES;
    });
    if (rendered === null) return null;
    fragment.append(rendered);
  }
  return count <= MAX_TREE_NODES ? fragment : null;
}

function renderNode(value: unknown, depth: number, spend: () => boolean): Node | null {
  if (depth > MAX_TREE_DEPTH || !spend() || !isRecord(value) || typeof value.type !== "string") return null;

  switch (value.type) {
    case "text":
    case "code":
      return onlyKeys(value, ["type", "text"]) && typeof value.text === "string"
        ? document.createTextNode(value.text)
        : null;
    case "break":
      return onlyKeys(value, ["type"]) ? document.createElement("br") : null;
    case "image": {
      if (!onlyKeys(value, ["type", "text"]) || typeof value.text !== "string") return null;
      const caption = document.createElement("span");
      caption.className = "reading-markdown-image-caption";
      caption.textContent = value.text.length > 0 ? `Image: ${value.text}` : "Image";
      return caption;
    }
    case "emphasis":
    case "strong":
    case "strike": {
      if (!onlyKeys(value, ["type", "children"]) || !Array.isArray(value.children)) return null;
      const tag = value.type === "emphasis" ? "em" : value.type === "strong" ? "strong" : "s";
      return appendChildren(document.createElement(tag), value.children, depth, spend);
    }
    case "link": {
      if (!onlyKeys(value, ["type", "href", "children"]) ||
        typeof value.href !== "string" || !Array.isArray(value.children)) return null;
      const href = getSafeReadingMarkdownHref(value.href);
      if (href === null) return appendChildren(document.createDocumentFragment(), value.children, depth, spend);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.rel = "noopener noreferrer";
      anchor.target = "_blank";
      return appendChildren(anchor, value.children, depth, spend);
    }
    case "paragraph":
    case "blockquote":
    case "listItem": {
      if (!onlyKeys(value, ["type", "children"]) || !Array.isArray(value.children)) return null;
      const tag = value.type === "paragraph" ? "p" : value.type === "blockquote" ? "blockquote" : "li";
      return appendChildren(document.createElement(tag), value.children, depth, spend);
    }
    case "table":
    case "tableHead":
    case "tableBody":
    case "tableRow": {
      if (!onlyKeys(value, ["type", "children"]) || !Array.isArray(value.children)) return null;
      const tag = value.type === "table" ? "table" : value.type === "tableHead" ? "thead" : value.type === "tableBody" ? "tbody" : "tr";
      return appendChildren(document.createElement(tag), value.children, depth, spend);
    }
    case "tableCell": {
      if (!onlyKeys(value, ["type", "header", "children"]) ||
        typeof value.header !== "boolean" || !Array.isArray(value.children)) return null;
      return appendChildren(document.createElement(value.header ? "th" : "td"), value.children, depth, spend);
    }
    case "heading": {
      if (!onlyKeys(value, ["type", "level", "children"]) || typeof value.level !== "number" ||
        !Number.isInteger(value.level) || value.level < 1 || value.level > 6 || !Array.isArray(value.children)) return null;
      return appendChildren(document.createElement(`h${value.level}`), value.children, depth, spend);
    }
    case "list": {
      if (!onlyKeys(value, ["type", "ordered", "children"]) ||
        typeof value.ordered !== "boolean" || !Array.isArray(value.children)) return null;
      return appendChildren(document.createElement(value.ordered ? "ol" : "ul"), value.children, depth, spend);
    }
    case "codeBlock": {
      if (!onlyKeys(value, ["type", "text"]) || typeof value.text !== "string") return null;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = value.text;
      pre.append(code);
      return pre;
    }
    case "rule":
      return onlyKeys(value, ["type"]) ? document.createElement("hr") : null;
    default:
      return null;
  }
}

function appendChildren(
  parent: Node,
  children: readonly unknown[],
  depth: number,
  spend: () => boolean,
): Node | null {
  for (const child of children) {
    const rendered = renderNode(child, depth + 1, spend);
    if (rendered === null) return null;
    parent.appendChild(rendered);
  }
  return parent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Object.keys(value);
  return ownKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
