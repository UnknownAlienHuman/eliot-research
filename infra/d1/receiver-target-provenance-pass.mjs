export function mergeModelQualificationPass(runPass) {
  const overrides = runPass("generic");
  for (const [path, targets] of runPass("model")) {
    const merged = overrides.get(path) ?? new Map();
    for (const [offset, target] of targets) merged.set(offset, target);
    overrides.set(path, merged);
  }
  // General evidence fills gaps only; owner-specific erasure/model facts keep precedence.
  for (const [path, targets] of runPass("general")) {
    const merged = overrides.get(path) ?? new Map();
    for (const [offset, target] of targets) if (!merged.has(offset)) merged.set(offset, target);
    overrides.set(path, merged);
  }
  return overrides;
}