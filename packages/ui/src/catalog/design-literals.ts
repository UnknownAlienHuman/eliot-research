/** The visual-value gate consumed by token qualification and the UI harness. */
export function assertSemanticVisualValues(source: string, file: string): void {
  if (file.includes("/tokens/")) return;
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//gu, "");
  if (/(?:#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\s*\()/iu.test(withoutComments)) {
    throw new Error(`Raw visual color outside tokens: ${file}`);
  }
  if (/\b(?:border-radius|font-size|z-index|transition-duration|animation-duration)\s*:\s*(?!var\(|inherit\b|0(?:;|\s))[\d.]+/iu.test(withoutComments)) {
    throw new Error(`Raw visual dimension outside tokens: ${file}`);
  }
  if (/\bstyle\s*=\s*["'{]/u.test(withoutComments)) throw new Error(`Inline visual style: ${file}`);
}
