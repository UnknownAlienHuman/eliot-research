import { describe, expect, it } from "vitest";
import { fromMarkdown } from "mdast-util-from-markdown";
import { resolveCitations, persistentResolvedAnswer } from "./citations.js";
import { cleanDistillText } from "./quotes.js";
import { sliceUtf8 } from "./blocks.js";
import { fencedCodeRanges, fencedRanges, inlineCodeRanges } from "./code-ranges.js";

const revisionId = "123e4567-e89b-12d3-a456-426614174000";
const first = "Доказательство 🌍.", second = "Second passage.";
const canonical = first + "\n\n" + second;
const bytes = (text: string) => new TextEncoder().encode(text).length;
const blocks = [
  { id: 1, type: "paragraph" as const, start: 0, end: bytes(first), heading: null },
  { id: 2, type: "paragraph" as const, start: bytes(first + "\n\n"), end: bytes(canonical), heading: null },
];
const sources = [{ sourceId: "source", revisionId, title: "Evidence", alias: "S1", blocks }];
const outside = "Outside [S1:1] bad [S9:9].";

describe("shared code boundaries retain separate reference policies", () => {
  it.each([0, 1, 2, 3, 4, 5])("matches Markdown escape parity for %i backslashes before a backtick", (count) => {
    const text = "Пролог 🌍 " + "\\".repeat(count) + "`literal [S1:1]` after [S1:2].";
    const parsed = fromMarkdown(text).children.flatMap(node => node.type === "paragraph"
      ? node.children.filter(child => child.type === "inlineCode").map(child => ({
        start: child.position?.start.offset, end: child.position?.end.offset,
      })) : []);
    expect(inlineCodeRanges(text, [])).toEqual(parsed);
    const result = resolveCitations(text, sources);
    expect(result.citations.map(c => c.block)).toEqual(count % 2 ? [1, 2] : [2]);
    expect(result.text).toBe(text);
  });

  it("escapes only the first tick of a run and treats backslashes inside code literally", () => {
    for (const text of ["\\``[S1:1]`", "`[S1:1]\\` then [S1:2]", "``[S1:1]\\`` then [S1:2]"]) {
      const parsed = fromMarkdown(text).children.flatMap(node => node.type === "paragraph"
        ? node.children.filter(child => child.type === "inlineCode").map(child => ({
          start: child.position?.start.offset, end: child.position?.end.offset,
        })) : []);
      expect(inlineCodeRanges(text, [])).toEqual(parsed);
      expect(resolveCitations(text, sources).citations.map(c => c.block)).toEqual(text.includes("[S1:2]") ? [2] : []);
    }
  });

  it("validates and persists prose references between escaped backticks, including unknown labels", () => {
    const text = "Пролог 🌍 \\` [S1:1] [S9:9] \\` suffix.";
    const resolved = resolveCitations(text, sources);
    expect(resolved.invalidLabels).toBe(1);
    expect(resolved.citations.map(c => c.block)).toEqual([1]);
    expect(resolved.text).toBe(text.replace("[S9:9]", ""));
    const saved = persistentResolvedAnswer(resolved.text, resolved.citations);
    expect(saved.text).toBe(resolved.text.replace("[S1:1]", `[R${revisionId}:1]`));
    expect(saved.citations[0]).toMatchObject({ revisionId, start: 0, end: bytes(first) });
    expect(cleanDistillText(text, ["[S1:1]"], revisionId)).toEqual({
      text: text.replace("[S1:1]", ""), invalidReferences: 1,
    });
  });

  it("walks many ordered fences without repeatedly searching earlier ranges", () => {
    const text = ("Text `inline` [S1:1].\n~~~\n[S9:9]\n~~~\n").repeat(500);
    let accesses = 0;
    const fences = fencedRanges(text).map(range => ({
      get start() { accesses++; return range.start; },
      get end() { accesses++; return range.end; },
    }));
    const inline = inlineCodeRanges(text, fences);
    expect(inline).toHaveLength(500);
    expect(inline.every(range => text.slice(range.start, range.end) === "`inline`")).toBe(true);
    expect(accesses).toBeLessThan(text.length * 4);
    const resolved = resolveCitations(text, sources);
    expect(resolved.text).toBe(text); expect(resolved.citations.map(citation => citation.block)).toEqual([1]);
    expect(resolved.invalidLabels).toBe(0);
  });
  it("exposes fence bodies without changing citation boundaries", () => {
    const text = "before\n~~~js\n++\n~~~~\nafter\n```\n//";
    const ranges = fencedCodeRanges(text);
    expect(ranges.map(range => [text.slice(range.contentStart, range.contentEnd), range.closed])).toEqual([["++\n", true], ["//", false]]);
    expect(fencedRanges(text)).toEqual(ranges.map(({ start, end }) => ({ start, end })));
  });
  it.each([
    { name: "unmatched backtick inside tilde fence", text: "~~~\n` [S1:2]\n~~~\n" + outside + " `", ids: [1], invalid: 1 },
    { name: "opener cannot cross a fence", text: "lead `\n~~~\n[S1:2]\n~~~\n" + outside + " `", ids: [1], invalid: 1 },
    { name: "variable inline run lengths", text: "``literal ` [S1:2]``\n" + outside, ids: [1], invalid: 1 },
    { name: "later span after unmatched run", text: "unmatched `` then `[S1:2]`.\n" + outside, ids: [1], invalid: 1 },
    { name: "shorter fence does not close", text: "~~~~\n[S1:2]\n~~~\n[S1:2]\n~~~~\n" + outside, ids: [1], invalid: 1 },
    { name: "unclosed inline run is prose", text: "unmatched ` [S1:2].\n" + outside, ids: [2, 1], invalid: 2 },
    { name: "unclosed tilde fence", text: "~~~\n[S1:2]\n" + outside, ids: [], invalid: 0 },
    { name: "unclosed backtick fence", text: "```\n[S1:2]\n" + outside, ids: [], invalid: 0 },
  ])("$name", ({ text, ids, invalid }) => {
    const input = "Пролог 🌍.\n\n" + text;
    const hasProse = ids.length > 0;
    const resolved = resolveCitations(input, sources);
    expect(resolved.citations.map(c => c.block)).toEqual(ids);
    expect(resolved.invalidLabels).toBe(hasProse ? 1 : 0);
    expect(resolved.text).toBe(hasProse ? input.replace(outside, outside.replace("[S9:9]", "")) : input);
    for (const citation of resolved.citations) {
      const block = blocks.find(b => b.id === citation.block);
      expect(citation).toMatchObject({ revisionId, sourceId: "source", start: block?.start, end: block?.end });
      expect(sliceUtf8(canonical, citation.start, citation.end)).toBe(citation.block === 1 ? first : second);
    }
    expect(cleanDistillText(input, ["[S1:1]"], revisionId)).toEqual({
      text: hasProse ? input.replace(outside, outside.replace("[S1:1]", "")) : input, invalidReferences: invalid,
    });
    expect(cleanDistillText(input, ["[S1:1]"], revisionId, true)).toEqual({
      text: hasProse ? input.replace(outside, outside.replace("[S1:1]", `[R${revisionId}:1]`)) : input, invalidReferences: invalid,
    });
    let saved = resolved.text;
    for (const id of ids) saved = saved.replace(`[S1:${id}]`, `[R${revisionId}:${id}]`);
    const persistent = persistentResolvedAnswer(resolved.text, resolved.citations);
    expect(persistent.text).toBe(saved);
    expect(persistent.citations.map(c => [c.revisionId, c.block, c.start, c.end]))
      .toEqual(resolved.citations.map(c => [c.revisionId, c.block, c.start, c.end]));
  });
});
