import { Link } from 'react-router';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './markdown.css';

export interface MarkdownReference { readonly text: string; readonly href: string; readonly label?: string; }
interface MarkdownNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: object;
  children?: MarkdownNode[];
}

export function Markdown({ text, references = [] }: { readonly text: string; readonly references?: readonly MarkdownReference[] }) {
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
  }}>{text}</ReactMarkdown>;
}
