import { Fragment, useMemo, type ReactNode } from "react";

// The existing reader's presentation limits. Original verified text remains authoritative.
const MAX_BYTES = 256 * 1024;
const MAX_NODES = 4096;
const MAX_DEPTH = 24;
type ReadingNode =
  | { readonly type: "text" | "code" | "image" | "codeBlock"; readonly text: string }
  | { readonly type: "paragraph" | "quote" | "strong" | "emphasis" | "listItem"; readonly children: readonly ReadingNode[] }
  | { readonly type: "link"; readonly href: string; readonly children: readonly ReadingNode[] }
  | { readonly type: "heading"; readonly level: number; readonly children: readonly ReadingNode[] }
  | { readonly type: "list"; readonly ordered: boolean; readonly start: number | undefined; readonly children: readonly ReadingNode[] };

export function safeMarkdownHref(value: string): string | undefined {
  if (!/^(https?:\/\/|mailto:)/iu.test(value) || /[\u0000-\u0020\u007f]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    if ((url.protocol === "https:" || url.protocol === "http:") && url.hostname) return url.href;
    if (url.protocol === "mailto:" && !url.hostname && url.pathname && !url.pathname.startsWith("//")) return url.href;
  } catch { return undefined; }
  return undefined;
}

/** A bounded reading subset. Unsupported syntax stays escaped text; raw HTML is never parsed. */
export function parseSafeMarkdown(text: string): readonly ReadingNode[] | undefined {
  if (text.length > MAX_BYTES || new TextEncoder().encode(text).byteLength > MAX_BYTES) return undefined;
  let nodes = 0;
  const spend = <T extends ReadingNode>(node: T): T => { if (++nodes > MAX_NODES) throw new Error("Reading node limit"); return node; };
  const inline = (value: string, depth = 0): ReadingNode[] => {
    if (depth > MAX_DEPTH) throw new Error("Reading depth limit");
    const result: ReadingNode[] = [];
    let start = 0;
    const plain = (end: number) => { if (end > start) result.push(spend({ type: "text", text: value.slice(start, end) })); };
    for (let index = 0; index < value.length;) {
      const image = value.startsWith("![", index);
      if (image || value[index] === "[") {
        const labelStart = index + (image ? 2 : 1);
        const labelEnd = value.indexOf("]", labelStart);
        if (labelEnd === -1) break;
        if (value[labelEnd + 1] === "(") {
          const urlEnd = value.indexOf(")", labelEnd + 2);
          if (urlEnd === -1) break;
          plain(index);
          const label = value.slice(labelStart, labelEnd);
          if (image) result.push(spend({ type: "image", text: label }));
          else result.push(spend({ type: "link", href: value.slice(labelEnd + 2, urlEnd), children: inline(label, depth + 1) }));
          index = urlEnd + 1; start = index; continue;
        }
        // Unsupported bracketed text stays literal. Skip the scanned label so a long run
        // of opening brackets cannot repeatedly search the same suffix on the UI thread.
        index = labelEnd + 1;
        continue;
      }
      const character = value[index];
      const marker = character === "`" ? "`" : value.startsWith("**", index) ? "**" : value.startsWith("__", index) ? "__" : character === "*" ? "*" : undefined;
      if (marker) {
        const end = value.indexOf(marker, index + marker.length);
        if (end === -1) break;
        if (end > index + marker.length) {
          plain(index);
          const content = value.slice(index + marker.length, end);
          result.push(marker === "`" ? spend({ type: "code", text: content })
            : spend({ type: marker.length === 2 ? "strong" : "emphasis", children: inline(content, depth + 1) }));
          index = end + marker.length; start = index; continue;
        }
      }
      index += 1;
    }
    plain(value.length);
    return result;
  };
  try {
    const lines = text.replace(/\r\n?/gu, "\n").split("\n");
    const result: ReadingNode[] = [];
    for (let index = 0; index < lines.length;) {
      const line = lines[index] ?? "";
      if (!line.trim()) { index += 1; continue; }
      const fence = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
      if (fence) {
        const marker = fence[1] ?? "```";
        let end = index + 1;
        while (end < lines.length && !(lines[end] ?? "").trim().startsWith(marker)) end += 1;
        result.push(spend({ type: "codeBlock", text: lines.slice(index + 1, end).join("\n") }));
        index = Math.min(lines.length, end + 1); continue;
      }
      const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
      if (heading) { result.push(spend({ type: "heading", level: (heading[1] ?? "#").length, children: inline(heading[2] ?? "") })); index += 1; continue; }
      const list = /^\s{0,3}([-+*]|\d+\.)\s+(.+)$/u.exec(line);
      if (list) {
        const ordered = /\d/u.test(list[1] ?? "");
        const start = ordered ? Number((list[1] ?? "1.").slice(0, -1)) : undefined;
        if (start !== undefined && !Number.isSafeInteger(start)) throw new Error("Invalid reading list start");
        const children: ReadingNode[] = [];
        while (index < lines.length) {
          const item = /^\s{0,3}([-+*]|\d+\.)\s+(.+)$/u.exec(lines[index] ?? "");
          if (!item || /\d/u.test(item[1] ?? "") !== ordered) break;
          children.push(spend({ type: "listItem", children: inline(item[2] ?? "") })); index += 1;
        }
        result.push(spend({ type: "list", ordered, start, children })); continue;
      }
      if (line.startsWith("> ")) { result.push(spend({ type: "quote", children: inline(line.slice(2)) })); index += 1; continue; }
      const paragraph: string[] = [line]; index += 1;
      while (index < lines.length && (lines[index] ?? "").trim() && !/^(#{1,6}\s|> |\s{0,3}([-+*]|\d+\.)\s|\s{0,3}(`{3,}|~{3,}))/u.test(lines[index] ?? "")) {
        paragraph.push(lines[index] ?? ""); index += 1;
      }
      result.push(spend({ type: "paragraph", children: inline(paragraph.join("\n")) }));
    }
    return result;
  } catch { return undefined; }
}

function renderNodes(nodes: readonly ReadingNode[]): ReactNode {
  return nodes.map((node, index) => <Fragment key={index}>{renderNode(node)}</Fragment>);
}
function renderNode(node: ReadingNode): ReactNode {
  switch (node.type) {
    case "text": return node.text;
    case "code": return <code>{node.text}</code>;
    case "codeBlock": return <pre><code>{node.text}</code></pre>;
    case "image": return <span className="er-safe-markdown__caption">{node.text}</span>;
    case "paragraph": return <p>{renderNodes(node.children)}</p>;
    case "quote": return <blockquote>{renderNodes(node.children)}</blockquote>;
    case "strong": return <strong>{renderNodes(node.children)}</strong>;
    case "emphasis": return <em>{renderNodes(node.children)}</em>;
    case "link": { const href = safeMarkdownHref(node.href); return href ? <a href={href} rel="noopener noreferrer" target="_blank">{renderNodes(node.children)}</a> : renderNodes(node.children); }
    case "listItem": return <li>{renderNodes(node.children)}</li>;
    case "list": return node.ordered ? <ol start={node.start}>{renderNodes(node.children)}</ol> : <ul>{renderNodes(node.children)}</ul>;
    case "heading": { const Heading = node.level <= 2 ? "h3" : node.level === 3 ? "h4" : "h5"; return <Heading>{renderNodes(node.children)}</Heading>; }
  }
}
export function SafeMarkdown({ text }: { readonly text: string }) {
  const nodes = useMemo(() => parseSafeMarkdown(text), [text]);
  return <div className="er-safe-markdown">{nodes ? renderNodes(nodes) : <pre className="er-safe-markdown__plain">{text}</pre>}</div>;
}
