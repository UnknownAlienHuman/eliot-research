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

export function estimateModelInput(request: { instructions: string; messages: ReadonlyArray<{ role: string; content: string }>; schema?: unknown }): number {
  const skeleton = { ...request, instructions: "", messages: request.messages.map(({ role }) => ({ role, content: "" })) };
  let bytes = new TextEncoder().encode(JSON.stringify(skeleton)).byteLength + stringBytes(request.instructions) - 2;
  for (const message of request.messages) bytes += stringBytes(message.content) - 2;
  // Existing request estimate, not provider tokenization or a provider capacity.
  return Math.ceil(bytes / 3) + request.messages.length * 32 + 1024;
}

export function estimateHistoryMessage(message: { role: string; content: string }): number {
  // Every history message precedes the current question in the JSON array,
  // so its incremental request cost includes the separating comma.
  return Math.ceil((21 + stringBytes(message.role) + stringBytes(message.content)) / 3) + 32;
}
