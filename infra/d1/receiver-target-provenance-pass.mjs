export function mergeModelQualificationPass(runPass) {
  const overrides = runPass("generic");
  for (const [path, targets] of runPass("model")) {
    const merged = overrides.get(path) ?? new Map();
    for (const [offset, target] of targets) merged.set(offset, target);
    overrides.set(path, merged);
  }
  return overrides;
}
