const HTML_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});

const HTML_META = /[&<>"']/gu;

/** Escapes untrusted text before interpolation into an HTML template. */
export function escapeHtml(value: string): string {
  return value.replace(HTML_META, (character) => HTML_ENTITIES[character] ?? character);
}
