import { Link } from 'react-router';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './markdown.css';
import type { AnswerWarning } from '../shared/api';

export interface MarkdownReference { readonly text: string; readonly href: string; readonly label?: string; }
interface MarkdownNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: object;
  children?: MarkdownNode[];
}

export function Markdown({ text, references = [], warnings = [] }: { readonly text: string; readonly references?: readonly MarkdownReference[]; readonly warnings?: readonly AnswerWarning[] }) {
  // Advisory-only flags: UTF-16 [start, end) ranges in the answer text.
  // Mark the overlapping paragraph/list item/table row; do not pretend to
  // map exact words through Markdown entities. Malformed or out-of-range
  // spans are ignored so rendering never crashes.
  const clean = (warnings ?? []).filter((w): w is AnswerWarning =>
    !!w && typeof w.start === 'number' && typeof w.end === 'number'
    && Number.isFinite(w.start) && Number.isFinite(w.end)
    && w.start >= 0 && w.end > w.start && w.start < text.length && w.end <= text.length
    && (w.kind === 'missing-citation' || w.kind === 'unsupported-number'));
  function warningTitleFor(start: number | null | undefined, end: number | null | undefined): string | null {
    if (typeof start !== 'number' || typeof end !== 'number') return null;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return null;
    let missing = false;
    let number = false;
    for (const w of clean) {
      if (w.start < end && start < w.end) {
        if (w.kind === 'missing-citation') missing = true;
        else if (w.kind === 'unsupported-number') number = true;
      }
    }
    if (!missing && !number) return null;
    const parts: string[] = [];
    if (missing) parts.push('Advisory: this passage may lack a citation');
    if (number) parts.push('Advisory: a number here may lack cited support');
    return parts.join('; ');
  }
  function linkify(value: string): MarkdownNode[] {
    const hits = references.filter((ref) => ref.text !== '').flatMap((ref) => {
      const found: { at: number; ref: MarkdownReference }[] = [];
      let at = value.indexOf(ref.text);
      while (at !== -1) { found.push({ at, ref }); at = value.indexOf(ref.text, at + ref.text.length); }
      return found;
    }).sort((a, b) => a.at - b.at || b.ref.text.length - a.ref.text.length);
    const parts: MarkdownNode[] = [];
    let pos = 0;
    for (const { at, ref } of hits) {
      if (at < pos) continue;
      parts.push({ type: 'text', value: value.slice(pos, at) }, {
        type: 'element', tagName: 'a', properties: { href: ref.href },
        children: [{ type: 'text', value: ref.label ?? ref.text }],
      });
      pos = at + ref.text.length;
    }
    parts.push({ type: 'text', value: value.slice(pos) });
    return parts;
  }
  // Transform text nodes at every prose depth, before React components render.
  // Code and existing links are literal boundaries, including their descendants.
  function citationLinks() {
    function visit(node: MarkdownNode): void {
      if (!node.children || node.tagName === 'code' || node.tagName === 'pre' || node.tagName === 'a') return;
      node.children = node.children.flatMap((child) => {
        if (child.type === 'text' && child.value !== undefined) return linkify(child.value);
        visit(child);
        return [child];
      });
    }
    return visit;
  }
  return <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} rehypePlugins={[citationLinks]} components={{ img: () => null,
    a: ({ href, children, title }) => references.some((ref) => ref.href === href)
      ? <Link className='er-citation' to={href ?? ''} title={title}>{children}</Link>
      : <a href={href} title={title}>{children}</a>,
    p: ({ node, children, ...rest }) => {
      const title = warningTitleFor(node?.position?.start?.offset, node?.position?.end?.offset);
      if (title == null) return <p {...rest}>{children}</p>;
      const prev = (rest as { className?: string }).className;
      return <p {...rest} className={prev ? prev + ' er-answer-warn' : 'er-answer-warn'} title={title}>{children}</p>;
    },
    li: ({ node, children, ...rest }) => {
      const title = warningTitleFor(node?.position?.start?.offset, node?.position?.end?.offset);
      if (title == null) return <li {...rest}>{children}</li>;
      const prev = (rest as { className?: string }).className;
      return <li {...rest} className={prev ? prev + ' er-answer-warn' : 'er-answer-warn'} title={title}>{children}</li>;
    },
    tr: ({ node, children, ...rest }) => {
      const title = warningTitleFor(node?.position?.start?.offset, node?.position?.end?.offset);
      if (title == null) return <tr {...rest}>{children}</tr>;
      const prev = (rest as { className?: string }).className;
      return <tr {...rest} className={prev ? prev + ' er-answer-warn' : 'er-answer-warn'} title={title}>{children}</tr>;
    },
  }}>{text}</ReactMarkdown>;
}
