import MarkdownIt from "markdown-it/browser";

type InlineNode =
  | { type: "text" | "code" | "image"; text: string }
  | { type: "break" }
  | { type: "emphasis" | "strong" | "strike"; children: InlineNode[] }
  | { type: "link"; href: string; children: InlineNode[] };

type BlockNode =
  | { type: "paragraph" | "blockquote" | "listItem"; children: ReadingNode[] }
  | { type: "table" | "tableHead" | "tableBody" | "tableRow"; children: ReadingNode[] }
  | { type: "tableCell"; header: boolean; children: ReadingNode[] }
  | { type: "heading"; level: number; children: ReadingNode[] }
  | { type: "list"; ordered: boolean; start: number | null; children: ReadingNode[] }
  | { type: "codeBlock"; text: string }
  | { type: "rule" };

type ReadingNode = InlineNode | BlockNode;

interface ParseRequest {
  type: "parse-reading-markdown";
  text: string;
}

interface WorkerScope {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

interface NodeBudget {
  count: number;
}

interface ParserToken {
  readonly type: string;
  readonly tag: string;
  readonly content: string;
  readonly children: readonly ParserToken[] | null;
  attrGet(name: string): string | number | null;
}

type BlockContainer =
  | { type: "paragraph" | "blockquote" | "listItem"; children: ReadingNode[] }
  | { type: "table" | "tableHead" | "tableBody" | "tableRow"; children: ReadingNode[] }
  | { type: "tableCell"; header: boolean; children: ReadingNode[] }
  | { type: "heading"; level: number; children: ReadingNode[] }
  | { type: "list"; ordered: boolean; start: number | null; children: ReadingNode[] };

interface Frame {
  node: BlockContainer;
  closeToken: string;
}

const MAX_MARKDOWN_BYTES = 256 * 1024;
const MAX_TREE_NODES = 4096;
const MAX_TREE_DEPTH = 24;
const MAX_NESTING = 20;

const scope = globalThis as unknown as WorkerScope;
const parser = new MarkdownIt("default", {
  html: false,
  linkify: false,
  typographer: false,
  maxNesting: MAX_NESTING,
});

scope.onmessage = (event): void => {
  const request = readRequest(event.data);
  if (request === null || !isWithinLimit(request.text)) {
    scope.postMessage({ type: "reading-markdown-result", ok: false });
    return;
  }

  try {
    const budget: NodeBudget = { count: 0 };
    const tokens = parser.parse(request.text, {});
    const nodes = readBlocks(tokens, budget);
    scope.postMessage({ type: "reading-markdown-result", ok: true, nodes });
  } catch {
    scope.postMessage({ type: "reading-markdown-result", ok: false });
  }
};

function readRequest(value: unknown): ParseRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return record.type === "parse-reading-markdown" && typeof record.text === "string" &&
    Object.keys(record).length === 2
    ? { type: "parse-reading-markdown", text: record.text }
    : null;
}

function isWithinLimit(text: string): boolean {
  if (text.length > MAX_MARKDOWN_BYTES) return false;
  return new TextEncoder().encode(text).byteLength <= MAX_MARKDOWN_BYTES;
}

function spend(budget: NodeBudget): void {
  budget.count += 1;
  if (budget.count > MAX_TREE_NODES) throw new Error("Markdown tree node budget exceeded");
}

function readBlocks(tokens: readonly ParserToken[], budget: NodeBudget): BlockNode[] {
  const root: BlockNode[] = [];
  const frames: Frame[] = [];
  const currentChildren = (): ReadingNode[] => {
    const active = frames.at(-1);
    return active === undefined ? root : active.node.children;
  };
  const open = (node: BlockContainer, closeToken: string, depth: number): void => {
    if (depth > MAX_TREE_DEPTH) throw new Error("Markdown tree depth exceeded");
    spend(budget);
    currentChildren().push(node);
    frames.push({ node, closeToken });
  };

  for (const token of tokens) {
    switch (token.type) {
      case "paragraph_open":
        open({ type: "paragraph", children: [] }, "paragraph_close", frames.length + 1);
        break;
      case "heading_open": {
        const level = Number(token.tag.slice(1));
        if (!Number.isInteger(level) || level < 1 || level > 6) throw new Error("Invalid heading token");
        open({ type: "heading", level, children: [] }, "heading_close", frames.length + 1);
        break;
      }
      case "blockquote_open":
        open({ type: "blockquote", children: [] }, "blockquote_close", frames.length + 1);
        break;
      case "bullet_list_open":
        open({ type: "list", ordered: false, start: null, children: [] }, "bullet_list_close", frames.length + 1);
        break;
      case "ordered_list_open": {
        const start = Number(token.attrGet("start") ?? 1);
        if (!Number.isInteger(start) || start < 0 || start > 999_999_999) throw new Error("Invalid ordered list start");
        open({ type: "list", ordered: true, start, children: [] }, "ordered_list_close", frames.length + 1);
        break;
      }
      case "list_item_open":
        open({ type: "listItem", children: [] }, "list_item_close", frames.length + 1);
        break;
      case "table_open":
        open({ type: "table", children: [] }, "table_close", frames.length + 1);
        break;
      case "thead_open":
        open({ type: "tableHead", children: [] }, "thead_close", frames.length + 1);
        break;
      case "tbody_open":
        open({ type: "tableBody", children: [] }, "tbody_close", frames.length + 1);
        break;
      case "tr_open":
        open({ type: "tableRow", children: [] }, "tr_close", frames.length + 1);
        break;
      case "th_open":
        open({ type: "tableCell", header: true, children: [] }, "th_close", frames.length + 1);
        break;
      case "td_open":
        open({ type: "tableCell", header: false, children: [] }, "td_close", frames.length + 1);
        break;
      case "paragraph_close":
      case "heading_close":
      case "blockquote_close":
      case "bullet_list_close":
      case "ordered_list_close":
      case "list_item_close":
      case "table_close":
      case "thead_close":
      case "tbody_close":
      case "tr_close":
      case "th_close":
      case "td_close":
        close(frames, token.type);
        break;
      case "inline": {
        const inline = readInline(token.children ?? [], budget, frames.length + 1);
        const active = frames[frames.length - 1]?.node;
        if (active?.type === "paragraph" || active?.type === "heading" || active?.type === "tableCell") {
          active.children.push(...inline);
        } else {
          spend(budget);
          currentChildren().push({ type: "paragraph", children: inline });
        }
        break;
      }
      case "fence":
      case "code_block":
        spend(budget);
        currentChildren().push({ type: "codeBlock", text: token.content });
        break;
      case "hr":
        spend(budget);
        currentChildren().push({ type: "rule" });
        break;
      case "html_block":
        appendPlainText(token.content, currentChildren(), budget);
        break;
      default:
        if (token.content.length > 0) appendPlainText(token.content, currentChildren(), budget);
        break;
    }
  }

  if (frames.length !== 0) throw new Error("Unclosed Markdown block");
  return root;
}

function close(frames: Frame[], tokenType: string): void {
  const top = frames[frames.length - 1];
  if (top === undefined || top.closeToken !== tokenType) throw new Error("Invalid Markdown block nesting");
  frames.pop();
}

function appendPlainText(text: string, target: ReadingNode[], budget: NodeBudget): void {
  spend(budget);
  spend(budget);
  target.push({ type: "paragraph", children: [{ type: "text", text }] });
}

function readInline(tokens: readonly ParserToken[], budget: NodeBudget, depth: number): InlineNode[] {
  if (depth > MAX_TREE_DEPTH) throw new Error("Markdown tree depth exceeded");
  const root: InlineNode[] = [];
  const frames: { readonly node: Extract<InlineNode, { children: InlineNode[] }>; readonly closeToken: string }[] = [];
  const target = (): InlineNode[] => {
    const active = frames.at(-1);
    return active === undefined ? root : active.node.children;
  };
  const open = (
    type: "emphasis" | "strong" | "strike" | "link",
    closeToken: string,
    href?: string,
  ): void => {
    if (depth + frames.length + 1 > MAX_TREE_DEPTH) throw new Error("Markdown tree depth exceeded");
    spend(budget);
    const node: Extract<InlineNode, { children: InlineNode[] }> = type === "link"
      ? { type, href: href ?? "", children: [] }
      : { type, children: [] };
    target().push(node);
    frames.push({ node, closeToken });
  };

  for (const token of tokens) {
    switch (token.type) {
      case "text":
      case "html_inline":
        appendInline({ type: "text", text: token.content }, target(), budget);
        break;
      case "code_inline":
        appendInline({ type: "code", text: token.content }, target(), budget);
        break;
      case "softbreak":
      case "hardbreak":
        spend(budget);
        target().push({ type: "break" });
        break;
      case "image":
        appendInline({ type: "image", text: token.content }, target(), budget);
        break;
      case "em_open":
        open("emphasis", "em_close");
        break;
      case "strong_open":
        open("strong", "strong_close");
        break;
      case "s_open":
        open("strike", "s_close");
        break;
      case "link_open": {
        const href = token.attrGet("href");
        open("link", "link_close", typeof href === "string" ? href : "");
        break;
      }
      case "em_close":
      case "strong_close":
      case "s_close":
      case "link_close":
        closeInline(frames, token.type);
        break;
      default:
        if (token.content.length > 0) appendInline({ type: "text", text: token.content }, target(), budget);
        break;
    }
  }

  if (frames.length !== 0) throw new Error("Unclosed Markdown inline node");
  return root;
}

function appendInline(node: InlineNode, target: InlineNode[], budget: NodeBudget): void {
  spend(budget);
  target.push(node);
}

function closeInline(
  frames: { readonly node: Extract<InlineNode, { children: InlineNode[] }>; readonly closeToken: string }[],
  tokenType: string,
): void {
  const top = frames[frames.length - 1];
  if (top === undefined || top.closeToken !== tokenType) throw new Error("Invalid Markdown inline nesting");
  frames.pop();
}
