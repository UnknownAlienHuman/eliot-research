function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", copy)));
}

export function sha256HexText(value: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(value));
}
