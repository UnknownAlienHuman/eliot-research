import { describe, expect, it } from "vitest";
import { createResearchAnswerTextReader } from "./research-answer-text.js";

const reader = () => createResearchAnswerTextReader({ max_output_bytes: 4096, max_answer_bytes: 1024 });

describe("provisional full-answer JSON text extraction", () => {
  it("emits answer text before the JSON/citations finish and never exposes citation content", () => {
    const stream = reader();
    expect(stream.append('{"answer_markdown":"Visible')).toBe("Visible");
    expect(stream.append(' answer","citations":[{"quote":"PRIVATE SOURCE TEXT"}]}')).toBe(" answer");
    expect(stream.finish()).toBe("Visible answer");
  });

  it("ignores nested names and strings before the actual top-level answer", () => {
    const stream = reader();
    expect(stream.append('{"citations":[{"answer_markdown":"never emit"}],"answer_markdown":"yes"}')).toBe("yes");
    expect(stream.finish()).toBe("yes");
  });

  it.each(["plain", "Русский текст 🧠", 'quote " slash \\ line\n tab\t', "prefix } : { suffix"])("preserves %j across every character boundary", answer => {
    const stream = reader();
    const output = JSON.stringify({ citations: [], answer_markdown: answer });
    let visible = "";
    for (let index = 0; index < output.length; index += 1) visible += stream.append(output.charAt(index));
    expect(visible).toBe(answer);
    expect(stream.finish()).toBe(answer);
  });

  it("decodes escaped field name and surrogate pair across deltas", () => {
    const stream = reader();
    expect(stream.append('{"answer_\\u006darkdown":"\\uD83E')).toBe("");
    expect(stream.append('\\uDDE0\\nnext"}')).toBe("🧠\nnext");
    expect(stream.finish()).toBe("🧠\nnext");
  });

  it.each([
    '{"answer_markdown":123}', '{"answer_markdown":"one","answer_markdown":"two"}',
    '{"answer_markdown":"\\uD800x"}', '{"answer_markdown":"\\uDC00"}',
    '{"answer_markdown":"bad\\q"}', '[{"answer_markdown":"nested"}]',
    '{"answer_markdown":"yes"} trailing',
  ])("rejects malformed answer transport %s", raw => {
    const stream = reader();
    expect(() => { stream.append(raw); stream.finish(); }).toThrow("ANSWER_STREAM_INVALID");
    expect(() => stream.append("anything")).toThrow("ANSWER_STREAM_INVALID");
  });

  it("rejects truncation rather than completing a partially visible answer", () => {
    const stream = reader();
    expect(stream.append('{"answer_markdown":"partial')).toBe("partial");
    expect(() => stream.finish()).toThrow("ANSWER_STREAM_INVALID");
  });

  it("validates the final JSON including malformed data after answer text", () => {
    const stream = reader();
    stream.append('{"answer_markdown":"visible",gaps:0}');
    expect(() => stream.finish()).toThrow("ANSWER_STREAM_INVALID");
  });

  it("bounds answer bytes and retained provider output independently", () => {
    const answerBound = createResearchAnswerTextReader({ max_output_bytes: 4096, max_answer_bytes: 3 });
    expect(() => answerBound.append('{"answer_markdown":"🧠"}')).toThrow("ANSWER_STREAM_LIMIT");
    const rawBound = createResearchAnswerTextReader({ max_output_bytes: 24, max_answer_bytes: 1024 });
    expect(() => rawBound.append('{"answer_markdown":"ok","citations":[]}')).toThrow("ANSWER_STREAM_LIMIT");
  });

  it("does not complete a second time or accept output after completion", () => {
    const stream = reader();
    stream.append('{"answer_markdown":"ok"}'); stream.finish();
    expect(() => stream.append(" ")).toThrow("ANSWER_STREAM_INVALID");
  });
});
