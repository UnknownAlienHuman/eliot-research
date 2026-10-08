import { resolve } from "node:path";
import { normalized } from "./receiver-target-provenance-values.mjs";
import { discoverConfiguredReceiverRoots } from "./receiver-target-general-roots.mjs";
import { traceConfiguredReceiverTargets } from "./receiver-target-general-flow.mjs";

/**
 * Private first-family draft. Root discovery sees all configured Worker/DO/
 * Workflow entrypoints, while this checkpoint emits only the Search projection
 * port source. No model/erasure SQL source is eligible here.
 */
export function createGeneralReceiverTargetOverrides({ root, files, program, checker }) {
  const roots = discoverConfiguredReceiverRoots({ root, program, checker });
  if (!roots.complete) return new Map();
  const sourcePath = normalized(resolve(root, "packages/cloudflare-projection/src/d1-search.ts"));
  const rootFiles = files.map((file) => resolve(file));
  const trace = traceConfiguredReceiverTargets({
    program,
    checker,
    roots: roots.roots,
    origins: roots.origins,
    nativePrepareDeclarations: roots.nativePrepareDeclarations,
    rootFiles,
    eligibleSource: (path) => path === sourcePath,
  });
  // The trace can report candidate results alongside an incomplete context. A
  // draft checkpoint fails closed globally rather than publishing a partial map.
  return trace.complete ? trace.overrides : new Map();
}
