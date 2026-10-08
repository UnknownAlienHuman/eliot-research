import {
  applyOrdinaryAccessRuntimeVars,
  normalizeTeamOrigin,
  resolveOrdinaryAccessRuntimeConfiguration,
  validateAccessRuntimeConfiguration,
  validateAudTag,
} from "./access-runtime-base.mjs";
import {
  applyMcpRuntimeVars,
  resolveMcpAccessRuntimeConfiguration,
} from "./access-runtime-mcp.mjs";

export { normalizeTeamOrigin, validateAccessRuntimeConfiguration, validateAudTag };
export { applyMcpRuntimeVars, resolveMcpAccessRuntimeConfiguration };

export function resolveAccessRuntimeConfiguration(environment, accessReceipt) {
  const ordinary = resolveOrdinaryAccessRuntimeConfiguration(environment, accessReceipt);
  const mcpAccessRuntime = accessReceipt?.mcp === undefined
    ? null
    : resolveMcpAccessRuntimeConfiguration(environment, accessReceipt, {
        ordinaryAudience: ordinary.audience,
        publicHostname: accessReceipt.hostname,
        profileDefault: accessReceipt.mcp?.auth_profile,
      });
  return Object.freeze({ ...ordinary, mcpAccessRuntime });
}

export function applyAccessRuntimeVars(vars, accessRuntime) {
  const ordinary = applyOrdinaryAccessRuntimeVars(vars, accessRuntime);
  return accessRuntime.mcpAccessRuntime === null || accessRuntime.mcpAccessRuntime === undefined
    ? ordinary
    : applyMcpRuntimeVars(ordinary, accessRuntime.mcpAccessRuntime);
}
