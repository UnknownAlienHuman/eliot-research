export function chatModelMessages(messages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }>, question: string) {
  const result: Array<{ role: "user" | "assistant"; content: string }> = [];
  // Evidence, orientation and the question can be adjacent parts of one user turn.
  // Some providers silently return empty completions for consecutive user roles.
  for (const message of [...messages, { role: "user", content: question }]) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const previous = result.at(-1);
    if (message.role === "user" && previous?.role === "user") previous.content += "\n\n" + message.content;
    else result.push({ role: message.role, content: message.content });
  }
  return result;
}

// UTF-8 size of JSON string serialization without allocating another full source
// string. JSON.stringify escapes lone surrogates; valid pairs remain four bytes.
function stringBytes(text: string): number {
  let bytes = 2;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 34 || code === 92) bytes += 2;
    else if (code < 32) bytes += [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
    else if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += code >= 0xd800 && code <= 0xdfff ? 6 : 3;
  }
  return bytes;
}

export function estimateModelInput(request: { instructions: string; messages: ReadonlyArray<{ role: string; content: string }>; schema?: unknown }, options: { joinUserMessages?: boolean } = {}): number {
  const messages: Array<{ role: string; content: string }> = [];
  let contentBytes = 0;
  for (const message of request.messages) {
    if (options.joinUserMessages && message.role === "user" && messages.at(-1)?.role === "user") contentBytes += 4; // Two escaped newlines.
    else messages.push({ role: message.role, content: "" });
    contentBytes += stringBytes(message.content) - 2;
  }
  const skeleton = { ...request, instructions: "", messages };
  let bytes = new TextEncoder().encode(JSON.stringify(skeleton)).byteLength + stringBytes(request.instructions) - 2;
  bytes += contentBytes;
  // Existing request estimate, not provider tokenization or a provider capacity.
  return Math.ceil(bytes / 3) + messages.length * 32 + 1024;
}

export function estimateHistoryMessage(message: { role: string; content: string }): number {
  // Every history message precedes the current question in the JSON array,
  // so its incremental request cost includes the separating comma.
  return Math.ceil((21 + stringBytes(message.role) + stringBytes(message.content)) / 3) + 32;
}
