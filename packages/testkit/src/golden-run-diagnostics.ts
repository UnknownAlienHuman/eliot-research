export interface GoldenRunDiagnostics {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly observed_unknowns: readonly string[];
}

const diagnosticsByResult = new WeakMap<object, GoldenRunDiagnostics>();

export function retainGoldenRunDiagnostics(result: object, diagnostics: GoldenRunDiagnostics): void {
  diagnosticsByResult.set(result, Object.freeze({
    passed: diagnostics.passed,
    failures: Object.freeze([...diagnostics.failures]),
    observed_unknowns: Object.freeze([...diagnostics.observed_unknowns]),
  }));
}

export function goldenRunDiagnosticsFor(result: object): GoldenRunDiagnostics | undefined {
  return diagnosticsByResult.get(result);
}
