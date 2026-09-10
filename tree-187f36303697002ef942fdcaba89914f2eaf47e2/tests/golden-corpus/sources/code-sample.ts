// Fixture: exact code search target. Implemented vs planned must not collapse.
// Implemented: exactPhraseSearch returns all expected matches in the frozen corpus.
export function exactPhraseSearch(corpus: readonly string[], phrase: string): readonly string[] {
  return corpus.filter((section) => section.includes(phrase));
}
// Planned (not implemented): semanticRerank is only a hypothesis, not an observed result.
export function semanticRerank(_candidates: readonly string[]): readonly string[] {
  throw new Error("not implemented: semantic rerank is planned");
}
