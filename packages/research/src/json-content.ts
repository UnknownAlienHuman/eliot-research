/**
 * Parse one JSON document from model content. A single complete JSON fence is
 * accepted for providers that wrap otherwise valid output; prose and partial
 * or multiple fences remain invalid. Callers assign their own error codes.
 */
export function parseSingleJsonContent(content: string): unknown {
  const trimmed = content.trim();
  const fenced = /^```json\r?\n([\s\S]*?)\r?\n```$/u.exec(trimmed);
  if (fenced !== null) return JSON.parse(fenced[1] ?? "");
  if (trimmed.startsWith("```")) {
    throw new SyntaxError("content must be one complete json code fence");
  }
  return JSON.parse(trimmed);
}
