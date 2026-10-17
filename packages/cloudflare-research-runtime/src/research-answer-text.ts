/** Incremental extraction only. The final synthesis decoder still validates citations and schema. */
export class ResearchAnswerTextError extends Error {
  constructor(readonly code: "ANSWER_STREAM_INVALID" | "ANSWER_STREAM_LIMIT") {
    super(code);
  }
}

/**
 * Extract only the top-level JSON answer_markdown string from public provider output text.
 * Callers must never pass reasoning deltas. Returned text is provisional until final validation/save.
 */
export function createResearchAnswerTextReader(limits: {
  readonly max_output_bytes: number;
  readonly max_answer_bytes: number;
}) {
  for (const bound of [limits.max_output_bytes, limits.max_answer_bytes]) {
    if (!Number.isSafeInteger(bound) || bound <= 0) throw new ResearchAnswerTextError("ANSWER_STREAM_LIMIT");
  }
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let outputBytes = 0, answerBytes = 0, rawHigh = false;
  let depth = 0, rootSeen = false, rootEnded = false, expectKey = false, expectColon = false, expectValue = false;
  let stringKind: "key" | "answer" | "other" | undefined;
  let key = "", keyRaw = "", skipEscape = false, answerSeen = false, answer = "";
  let escape: "" | "slash" | "unicode" = "", hex = "", high = "";
  let failed = false, finished = false;
  const invalid = (): never => { failed = true; throw new ResearchAnswerTextError("ANSWER_STREAM_INVALID"); };
  const exceeded = (): never => { failed = true; throw new ResearchAnswerTextError("ANSWER_STREAM_LIMIT"); };
  const emitUnit = (unit: string): string => {
    const code = unit.charCodeAt(0);
    if (high !== "") {
      if (code < 0xdc00 || code > 0xdfff) return invalid();
      const pair = high + unit;
      high = "";
      return pair;
    }
    if (code >= 0xd800 && code <= 0xdbff) { high = unit; return ""; }
    if (code >= 0xdc00 && code <= 0xdfff) return invalid();
    return unit;
  };
  const answerUnit = (character: string): string => {
    if (escape === "unicode") {
      if (!/^[0-9a-f]$/iu.test(character)) return invalid();
      hex += character;
      if (hex.length !== 4) return "";
      const unit = String.fromCharCode(Number.parseInt(hex, 16));
      hex = ""; escape = "";
      return emitUnit(unit);
    }
    if (escape === "slash") {
      escape = "";
      if (character === "u") { escape = "unicode"; return ""; }
      const escapes: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      const unit = escapes[character];
      return unit === undefined ? invalid() : emitUnit(unit);
    }
    if (character === "\\") { escape = "slash"; return ""; }
    if (character === '"') {
      if (high !== "") return invalid();
      stringKind = undefined;
      return "";
    }
    if (character.charCodeAt(0) < 0x20) return invalid();
    return emitUnit(character);
  };
  const countRaw = (delta: string) => {
    // Count UTF-8 without repairing a surrogate pair split between provider deltas.
    for (let index = 0; index < delta.length; index += 1) {
      const code = delta.charCodeAt(index);
      if (rawHigh) {
        rawHigh = false;
        if (code >= 0xdc00 && code <= 0xdfff) { outputBytes += 4; continue; }
        outputBytes += 3;
      }
      if (code >= 0xd800 && code <= 0xdbff) rawHigh = true;
      else outputBytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    }
    if (outputBytes + (rawHigh ? 3 : 0) > limits.max_output_bytes) exceeded();
  };
  return {
    append(delta: string): string {
      if (failed || finished || typeof delta !== "string") return invalid();
      countRaw(delta);
      chunks.push(delta);
      let text = "";
      for (let index = 0; index < delta.length; index += 1) {
        const character = delta.charAt(index);
        if (stringKind === "answer") { text += answerUnit(character); continue; }
        if (stringKind !== undefined) {
          if (stringKind === "key") keyRaw += character;
          if (skipEscape) skipEscape = false;
          else if (character === "\\") skipEscape = true;
          else if (character === '"') {
            if (stringKind === "key") {
              try { key = JSON.parse(keyRaw) as string; } catch { return invalid(); }
              expectKey = false; expectColon = true;
            }
            stringKind = undefined;
          }
          continue;
        }
        if (/^[\x20\t\n\r]$/u.test(character)) continue;
        if (rootEnded) return invalid();
        if (!rootSeen) {
          if (character !== "{") return invalid();
          rootSeen = true; depth = 1; expectKey = true; continue;
        }
        if (depth === 1 && expectColon) {
          if (character !== ":") return invalid();
          expectColon = false; expectValue = true; continue;
        }
        if (depth === 1 && expectValue) {
          expectValue = false;
          if (key === "answer_markdown") {
            if (answerSeen || character !== '"') return invalid();
            answerSeen = true; stringKind = "answer"; continue;
          }
        }
        if (character === '"') {
          stringKind = depth === 1 && expectKey ? "key" : "other";
          keyRaw = '"'; skipEscape = false;
        } else if (character === "{" || character === "[") depth += 1;
        else if (character === "}" || character === "]") {
          depth -= 1;
          if (depth < 0 || (depth === 0 && character !== "}")) return invalid();
          if (depth === 0) rootEnded = true;
        } else if (character === "," && depth === 1) expectKey = true;
      }
      answerBytes += encoder.encode(text).byteLength;
      if (answerBytes > limits.max_answer_bytes) exceeded();
      answer += text;
      return text;
    },
    finish(): string {
      if (failed || finished || !rootEnded || stringKind !== undefined || !answerSeen || high !== "") return invalid();
      let parsed: unknown;
      try { parsed = JSON.parse(chunks.join("")); } catch { return invalid(); }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
          !("answer_markdown" in parsed) || parsed.answer_markdown !== answer) return invalid();
      finished = true;
      return answer;
    },
  };
}
