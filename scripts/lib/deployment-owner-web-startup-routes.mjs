// Authenticated metadata reads performed by the unselected-project shell.
// Per-provider catalog reads and scientific mutations are deliberately absent.
export const ownerWebStartupReadOnlyPaths = Object.freeze([
  "/api/v1/system/health", "/api/v1/system/session", "/api/v1/research/projects",
  "/api/v1/research/runs", "/api/v1/system/research-configuration",
  "/api/v1/system/model-settings", "/api/v2/system/model-providers",
  "/api/v2/system/model-provider-catalog-preferences", "/api/v1/system/research-models",
  "/api/v1/system/computer-agents",
]);
