export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
