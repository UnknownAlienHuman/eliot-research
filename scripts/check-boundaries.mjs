import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_ROOTS = ["packages", "apps"];
const FORBIDDEN_IMPORTS = [
  "langchain",
  "@langchain/",
  "llamaindex",
  "@llamaindex/",
  "prisma",
  "@prisma/",
  "googleapis",
  "@google-cloud/",
  "playwright",
  "puppeteer",
  "child_process",
  "node:child_process",
  "node:fs",
  "node:fs/promises",
  "better-sqlite3",
  "sqlite3",
];

// These exact files import host-side tools for Node checks/tests; they are not
// production Worker or browser-bundle entry points. Keep exceptions exact by
// repository path and specifier. Backup tests read checked-in migration SQL,
// and the PWA build script reads local source files to generate its asset.
const HOST_TOOL_IMPORTS = new Map([
  ["packages/backup-o2/src/coverage-full-chain.test.ts", new Set(["node:fs"])],
  ["packages/cloudflare-backup/src/backup-epoch-manifest-publisher.test.ts", new Set(["node:fs/promises"])],
  ["packages/cloudflare-backup/src/primary-writer-admission.test.ts", new Set(["node:fs/promises"])],
  ["packages/cloudflare-backup/src/isolated-restore-preflight.test.ts", new Set(["node:fs/promises"])],
  ["packages/cloudflare-backup/src/restore-admission.test.ts", new Set(["node:fs/promises"])],
  ["packages/cloudflare-backup/src/restore-native-history-ordering.test.ts", new Set(["node:fs/promises"])],
  ["packages/cloudflare-backup/src/restore-store.test.ts", new Set(["node:fs/promises"])],
  ["packages/cloudflare-model-control/src/research-model-qualification-renewal.test.ts", new Set(["node:fs"])],
  ["packages/cloudflare-research/src/research-model-spend-admission-branch-stages.test.ts", new Set(["node:fs"])],
  ["packages/cloudflare-research/src/research-project-configuration-store.test.ts", new Set(["node:fs"])],
  ["packages/cloudflare-workflows/src/research-run-configuration-store.test.ts", new Set(["node:fs"])],
  ["apps/eliotr-core/test/agent-inbox-assets-routing.test.mjs", new Set(["node:fs/promises", "playwright-core"])],
  ["apps/eliotr-core/test/research-runtime-config-parity.test.ts", new Set(["node:fs/promises"])],
  ["apps/eliotr-pwa/scripts/build-agent-inbox.mjs", new Set(["node:fs/promises"])],
]);

const MODEL_CONTROL_IMPORTS = [
  "@eliotr/cloudflare-model-control/research-model-qualification-http-error-classifier.js",
  "@eliotr/cloudflare-model-control/research-prepared-model-transport-policies.js",
  "@eliotr/cloudflare-model-control/research-provider-model-catalog.js",
  "@eliotr/cloudflare-model-control/research-model-catalog.js",
  "@eliotr/cloudflare-model-control",
  "@eliotr/cloudflare-model-control/model-gateway-deployment-registry-d1.js",
  "@eliotr/cloudflare-model-control/model-gateway-qualification-d1.js",
  "@eliotr/cloudflare-model-control/model-gateway-qualification-readers.js",
  "@eliotr/cloudflare-model-control/research-model-profile-binding.js",
  "@eliotr/cloudflare-model-control/research-model-profile-config.js",
  "@eliotr/cloudflare-model-control/research-model-pricing-store.js",
  "@eliotr/cloudflare-model-control/research-model-pricing-quote.js",
  "@eliotr/cloudflare-model-control/research-model-qualification-store.js",
  "@eliotr/cloudflare-model-control/research-model-qualification.js",
  "@eliotr/cloudflare-model-control/research-model-qualification-renewal.js",
  "@eliotr/cloudflare-model-control/research-model-qualification-dispatch.js",
  "@eliotr/cloudflare-model-control/research-qualification-prompt.js",
  "@eliotr/cloudflare-model-control/research-qualification-manifest-store.js",
  "@eliotr/cloudflare-model-control/research-model-prompt.js",
  "@eliotr/cloudflare-model-control/research-model-fingerprint-store.js",
  "@eliotr/cloudflare-model-control/research-model-gateway-binding.js",
  "@eliotr/cloudflare-model-control/research-model-gateway-runtime.js",
];
const RESEARCH_UI_IMPORTS = [
  "@eliotr/pwa-research-workspace/research-run-panel",
  "@eliotr/pwa-research-workspace/research-changes-panel",
  "@eliotr/pwa-research-workspace/research-configuration-panel",
  "@eliotr/pwa-research-workspace/research-run-api",
  "@eliotr/pwa-research-workspace/research-run-report",
  "@eliotr/pwa-research-workspace/research-run-reauthorization-api",
  "@eliotr/pwa-research-workspace/wiki-proposal-create-api",
  "@eliotr/pwa-research-workspace/research-model-configuration-api",
];
const MODEL_EXECUTION_IMPORTS = [
  "@eliotr/cloudflare-model-execution",
  "@eliotr/cloudflare-model-execution/model-attempt-handler.js",
  "@eliotr/cloudflare-model-execution/model-attempt-types.js",
  "@eliotr/cloudflare-model-execution/model-attempt-store.js",
  "@eliotr/cloudflare-model-execution/model-attempt-readback.js",
  "@eliotr/cloudflare-model-execution/research-model-attempt-revalidator.js",
  "@eliotr/cloudflare-model-execution/research-model-output-store.js",
  "@eliotr/cloudflare-model-execution/research-model-output-preparation.js",
  "@eliotr/cloudflare-model-execution/research-model-stage-handler.js",
  "@eliotr/cloudflare-model-execution/research-model-spend-admission.js",
  "@eliotr/cloudflare-model-execution/research-model-spend-policy.js",
  "@eliotr/cloudflare-model-execution/research-model-spend-observation.js",
  "@eliotr/cloudflare-model-execution/research-model-spend-settlement.js",
  "@eliotr/cloudflare-model-execution/research-model-spend-admission-types.js"
];
const RESEARCH_BRANCH_IMPORTS = [
  "@eliotr/cloudflare-research-branches",
  "@eliotr/cloudflare-research-branches/research-branch-execution.js",
  "@eliotr/cloudflare-research-branches/research-branch-execution-context.js",
  "@eliotr/cloudflare-research-branches/research-branch-execution-results.js",
  "@eliotr/cloudflare-research-branches/research-branch-execution-shared.js",
  "@eliotr/cloudflare-research-branches/research-branch-role-model.js",
  "@eliotr/cloudflare-research-branches/research-branch-role-output.js",
  "@eliotr/cloudflare-research-branches/research-branch-role-preparation.js",
  "@eliotr/cloudflare-research-branches/research-branch-role-server-preparation.js",
  "@eliotr/cloudflare-research-branches/research-branch-role-evidence-pack.js",
  "@eliotr/cloudflare-research-branches/research-branch-role-manifest-store.js",
  "@eliotr/cloudflare-research-branches/research-external-branch-analysis.js",
  "@eliotr/cloudflare-research-branches/research-w1-observations.js",
  "@eliotr/cloudflare-research-branches/research-planning-manifest.js",
  "@eliotr/cloudflare-research-branches/research-inquiry-protocol.js",
  "@eliotr/cloudflare-research-branches/research-evidence-freeze.js",
  "@eliotr/cloudflare-research-branches/research-evidence-freeze-preparation.js",
  "@eliotr/cloudflare-research-branches/research-evidence-freeze-composition.js",
  "@eliotr/cloudflare-research-branches/research-evidence-freeze-branch-lineage.js",
  "@eliotr/cloudflare-research-branches/research-protocol-freeze.js"
];
const COMPUTER_AGENT_IMPORTS = [
  "@eliotr/cloudflare-computer-agent",
  "@eliotr/cloudflare-computer-agent/runtime",
  "@eliotr/cloudflare-computer-agent/computer-agent-http-support",
  "@eliotr/cloudflare-computer-agent/computer-agent-connection-http",
  "@eliotr/cloudflare-computer-agent/computer-agent-connection-store",
  "@eliotr/cloudflare-computer-agent/computer-agent-dispatch-abandonment",
  "@eliotr/cloudflare-computer-agent/computer-agent-dispatch-decline",
  "@eliotr/cloudflare-computer-agent/computer-agent-dispatch-error",
  "@eliotr/cloudflare-computer-agent/computer-agent-dispatch-http",
  "@eliotr/cloudflare-computer-agent/computer-agent-dispatch-reassignment",
  "@eliotr/cloudflare-computer-agent/computer-agent-dispatch-record",
  "@eliotr/cloudflare-computer-agent/computer-agent-dispatch-status",
  "@eliotr/cloudflare-computer-agent/computer-agent-dispatch-store",
  "@eliotr/cloudflare-computer-agent/computer-agent-preferred-dispatch",
  "@eliotr/cloudflare-computer-agent/computer-agent-qualification-http",
  "@eliotr/cloudflare-computer-agent/computer-agent-qualification-store",
  "@eliotr/cloudflare-computer-agent/computer-agent-route-http",
  "@eliotr/cloudflare-computer-agent/computer-agent-route-readiness",
  "@eliotr/cloudflare-computer-agent/computer-agent-route-store"
];
const WIKI_IMPORTS = [
  "@eliotr/cloudflare-wiki",
  "@eliotr/cloudflare-wiki/wiki-owner-edit-proposal",
  "@eliotr/cloudflare-wiki/wiki-owner-edit-review-admission",
  "@eliotr/cloudflare-wiki/wiki-owner-edit-review-proof",
  "@eliotr/cloudflare-wiki/wiki-owner-publication-guard",
  "@eliotr/cloudflare-wiki/wiki-proposal-from-research-run",
  "@eliotr/cloudflare-wiki/wiki-proposal-reauthorization",
  "@eliotr/cloudflare-wiki/wiki-publication-store",
  "@eliotr/cloudflare-wiki/wiki-publication-store-support",
  "@eliotr/cloudflare-wiki/wiki-review-admission",
  "@eliotr/cloudflare-wiki/wiki-runtime",
  "@eliotr/cloudflare-wiki/wiki-service"
];
const WORKSPACE_CAPABILITY_IMPORTS = [
  "@eliotr/cloudflare-workspace-mcp/workspace-owner-authorization.js",
  "@eliotr/cloudflare-workspace-mcp/research-application-dispatch.js",
  "@eliotr/cloudflare-workspace-mcp/research-service-operations.js",
  "@eliotr/cloudflare-workspace-mcp/research-project-membership.js",
  "@eliotr/cloudflare-workspace-mcp/workspace-mcp-candidate-d1-store",
  "@eliotr/cloudflare-workspace-mcp/workspace-candidate-admission-service",
  "@eliotr/cloudflare-workspace-mcp/external-agent-result-wake",
  "@eliotr/cloudflare-workspace-mcp/mcp-external-agent-task"
];
const MODEL_TRANSPORT_IMPORTS = [
  "@eliotr/cloudflare-model-transport/model-gateway-execution-contract.js",
  "@eliotr/cloudflare-model-transport/model-gateway-execution.js",
  "@eliotr/cloudflare-model-transport/model-gateway-http-failure.js",
  "@eliotr/cloudflare-model-transport/model-gateway-http-request.js",
  "@eliotr/cloudflare-model-transport/model-gateway-openrouter-response.js",
  "@eliotr/cloudflare-model-transport/model-gateway-provider-native-request.js",
  "@eliotr/cloudflare-model-transport/model-gateway-provider-native-response.js",
  "@eliotr/cloudflare-model-transport/model-gateway-request.js",
  "@eliotr/cloudflare-model-transport/model-gateway-response.js",
  "@eliotr/cloudflare-model-transport/model-gateway-transport-policy.js"
];
const RESEARCH_RUNTIME_IMPORTS = [
  "@eliotr/cloudflare-research-runtime/research-semantic-composition.js",
  "@eliotr/cloudflare-research-runtime",
  "@eliotr/cloudflare-research-runtime/research-stage-handlers.js",
  "@eliotr/cloudflare-research-runtime/research-evidence-freeze-composition.js",
  "@eliotr/cloudflare-research-runtime/research-retrieve-branches.js",
  "@eliotr/cloudflare-research-runtime/research-retrieval-composition.js",
  "@eliotr/cloudflare-research-runtime/research-synthesis-prompt.js",
  "@eliotr/cloudflare-research-runtime/research-claim-audit-prompt.js",
  "@eliotr/cloudflare-research-runtime/research-runtime-duration.js",
  "@eliotr/cloudflare-research-runtime/research-branch-role-prompt.js",
  "@eliotr/cloudflare-research-runtime/research-changes.js",
  "@eliotr/cloudflare-research-runtime/research-changes-cursor.js",
  "@eliotr/cloudflare-research-runtime/library-readiness.js",
  "@eliotr/cloudflare-research-runtime/research-exact-search.js",
  "@eliotr/cloudflare-research-runtime/research-selected-model-transport.js",
  "@eliotr/cloudflare-research-runtime/research-semantic-native-model-runtime.js",
  "@eliotr/cloudflare-research-runtime/research-semantic-run-configuration-bindings.js",
  "@eliotr/cloudflare-research-runtime/research-branch-role-server-prompt.js",
  "@eliotr/cloudflare-research-runtime/research-external-agent-routing.js",
  "@eliotr/cloudflare-research-runtime/artifact-report-admission.js",
  "@eliotr/cloudflare-research-runtime/artifact-cow-model-admission.js",
  "@eliotr/cloudflare-research-runtime/artifact-section-revise-model.js",
  "@eliotr/cloudflare-research-runtime/research-semantic-server.js",
  "@eliotr/cloudflare-research-runtime/research-session-application.js",
  "@eliotr/cloudflare-research-runtime/research-session-status-application.js",
  "@eliotr/cloudflare-research-runtime/research-workflow-application.js"
];
const RESEARCH_CONFIGURATION_IMPORTS = [
  "@eliotr/cloudflare-research-configuration/research-run-configuration-admission.js",
  "@eliotr/cloudflare-research-configuration",
  "@eliotr/cloudflare-research-configuration/research-owner-document-preset.js",
  "@eliotr/cloudflare-research-configuration/research-owner-profile.js",
  "@eliotr/cloudflare-research-configuration/research-owner-report-policy.js",
  "@eliotr/cloudflare-research-configuration/research-owner-route-plan.js",
  "@eliotr/cloudflare-research-configuration/research-owner-runtime-config.js",
  "@eliotr/cloudflare-research-configuration/research-owner-semantic-config.js",
  "@eliotr/cloudflare-research-configuration/research-owner-spend-policy.js",
  "@eliotr/cloudflare-research-configuration/research-project-configuration.js",
  "@eliotr/cloudflare-research-configuration/research-project-configuration-validation.js",
  "@eliotr/cloudflare-research-configuration/research-configuration-status.js",
  "@eliotr/cloudflare-research-configuration/research-configuration-readiness.js",
  "@eliotr/cloudflare-research-configuration/research-semantic-config-revision.js",
  "@eliotr/cloudflare-research-configuration/research-run-configuration.js",
  "@eliotr/cloudflare-research-configuration/research-semantic-configuration-schema.js",
  "@eliotr/cloudflare-research-configuration/research-provider-key-model-use-service.js",
  "@eliotr/cloudflare-research-configuration/research-provider-key-model-use-plan.js",
  "@eliotr/cloudflare-research-configuration/research-provider-key-model-use-store.js",
  "@eliotr/cloudflare-research-configuration/research-provider-key-model-use-progress.js",
  "@eliotr/cloudflare-research-configuration/research-provider-key-model-use-current-scope.js",
  "@eliotr/cloudflare-research-configuration/research-provider-key-model-use-executor.js",
  "@eliotr/cloudflare-research-configuration/research-provider-key-model-pricing.js",
  "@eliotr/cloudflare-research-configuration/research-provider-key-model-pricing-catalog.js",
  "@eliotr/cloudflare-research-configuration/research-provider-key-model-price-observation-store.js",
  "@eliotr/cloudflare-research-configuration/research-qualification-renewal.js"
];
const PACKAGE_RULES = new Map([
  ["packages/cloudflare-http-protocol", new Set([
    "@eliotr/cloudflare-navigation", "@eliotr/interfaces", "@eliotr/platform-cloudflare",
  ])],
["packages/cloudflare-research-configuration", new Set(["@eliotr/cloudflare-ai","@eliotr/cloudflare-evidence","@eliotr/cloudflare-model-control","@eliotr/cloudflare-model-control/research-prepared-model-transport-policies.js","@eliotr/cloudflare-model-control/research-model-pricing-store.js","@eliotr/cloudflare-model-transport/model-gateway-http-request.js","@eliotr/cloudflare-model-transport/model-gateway-provider-native-response.js","@eliotr/cloudflare-native-models","@eliotr/cloudflare-research","@eliotr/cloudflare-research-stages","@eliotr/cloudflare-workflows","@eliotr/contracts","@eliotr/interfaces","@eliotr/platform-cloudflare","zod"])],
  ["packages/cloudflare-research-runtime", new Set([
    "@eliotr/cloudflare-artifacts/artifact-draft-reauthorization.js",
    "@eliotr/cloudflare-ai", "@eliotr/cloudflare-evidence", "@eliotr/cloudflare-navigation",
    "@eliotr/cloudflare-projection", "@eliotr/cloudflare-research", "@eliotr/cloudflare-research-stages",
    "@eliotr/cloudflare-workflows", "@eliotr/contracts", "@eliotr/domain", "@eliotr/interfaces",
    "@eliotr/platform-cloudflare", "@eliotr/policy", "@eliotr/retrieval", "@eliotr/research",
    "@eliotr/cloudflare-model-control", "@eliotr/cloudflare-model-execution",
    "@eliotr/cloudflare-research-branches", "@eliotr/cloudflare-research-configuration",
    "@eliotr/cloudflare-native-models",
    "@eliotr/cloudflare-research-configuration/research-owner-report-policy.js",
    "@eliotr/cloudflare-research-configuration/research-owner-spend-policy.js",
    "@eliotr/cloudflare-research-configuration/research-run-configuration.js",
    "@eliotr/cloudflare-research-configuration/research-semantic-configuration-schema.js",
  ])],
  ["packages/cloudflare-search-probe", new Set(["@eliotr/cloudflare-ai","@eliotr/cloudflare-evidence","@eliotr/contracts","@eliotr/platform-cloudflare","@eliotr/retrieval","zod"])],
  ["packages/cloudflare-model-transport", new Set(["@eliotr/contracts", "@eliotr/platform-cloudflare"])],
  ["packages/cloudflare-erasure-operations", new Set(["@eliotr/backup-o2", "@eliotr/cloudflare-erasure", "@eliotr/contracts", "@eliotr/interfaces"])],
  ["packages/cloudflare-computer-agent", new Set(["@eliotr/cloudflare-navigation", "@eliotr/contracts", "@eliotr/interfaces", "@eliotr/platform-cloudflare"])],
  ["packages/cloudflare-wiki", new Set(["@eliotr/cloudflare-evidence", "@eliotr/cloudflare-navigation", "@eliotr/cloudflare-research", "@eliotr/cloudflare-research-stages", "@eliotr/contracts", "@eliotr/interfaces", "@eliotr/research", "@eliotr/retrieval"])],
  ["packages/cloudflare-native-models", new Set(["@eliotr/cloudflare-ai", "@eliotr/cloudflare-model-control", "@eliotr/contracts", "@eliotr/platform-cloudflare"])],
  ["packages/cloudflare-model-execution", new Set(["@eliotr/cloudflare-ai", "@eliotr/cloudflare-evidence", "@eliotr/cloudflare-model-control", "@eliotr/cloudflare-native-models", "@eliotr/cloudflare-workflows", "@eliotr/contracts", "@eliotr/platform-cloudflare", "@eliotr/research", "zod"])],
  ["packages/cloudflare-research-branches", new Set(["@eliotr/cloudflare-ai", "@eliotr/cloudflare-evidence", "@eliotr/cloudflare-model-control", "@eliotr/cloudflare-model-execution", "@eliotr/cloudflare-workflows", "@eliotr/contracts", "@eliotr/domain", "@eliotr/platform-cloudflare", "@eliotr/policy", "@eliotr/research", "@eliotr/retrieval", "zod"])],
  ["packages/cloudflare-model-control", new Set(["@eliotr/interfaces", "@eliotr/cloudflare-ai", "@eliotr/cloudflare-evidence", "@eliotr/cloudflare-workflows", "@eliotr/contracts", "@eliotr/platform-cloudflare", "@eliotr/policy", "@eliotr/retrieval", "zod"])],
  ["packages/contracts", new Set(["zod"])],
  ["packages/domain", new Set(["@eliotr/contracts"])],
  ["packages/policy", new Set(["@eliotr/contracts", "@eliotr/domain"])],
  ["packages/retrieval", new Set(["@eliotr/contracts", "@eliotr/domain", "@eliotr/policy"])],
  ["packages/research", new Set(["@eliotr/contracts", "@eliotr/domain", "@eliotr/policy", "@eliotr/retrieval"])],
  ["packages/backup-o2", new Set(["@eliotr/contracts"])],
  ["packages/cloudflare-backup", new Set(["@eliotr/backup-o2", "@eliotr/contracts", "@eliotr/cloudflare-erasure"])],
  ["packages/platform-cloudflare", new Set(["@eliotr/cloudflare-backup", "@eliotr/backup-o2", "@eliotr/contracts", "@eliotr/domain", "@eliotr/retrieval", "@eliotr/research"])],
  ["packages/cloudflare-research", new Set([...MODEL_CONTROL_IMPORTS, ...MODEL_EXECUTION_IMPORTS, ...RESEARCH_BRANCH_IMPORTS, "@eliotr/cloudflare-workflows", "@eliotr/cloudflare-ai", "@eliotr/cloudflare-artifacts", "@eliotr/cloudflare-artifacts/artifact-draft.js", "@eliotr/cloudflare-artifacts/artifact-draft-reader.js", "@eliotr/cloudflare-artifacts/artifact-draft-types.js", "@eliotr/cloudflare-artifacts/artifact-publication.js", "@eliotr/cloudflare-artifacts/artifact-draft-reauthorization.js", "@eliotr/cloudflare-artifacts/artifact-draft-citations-reauthorization.js", "@eliotr/cloudflare-evidence", "@eliotr/contracts", "@eliotr/domain", "@eliotr/platform-cloudflare", "@eliotr/policy", "@eliotr/research", "@eliotr/retrieval"])],
  ["packages/cloudflare-research-stages", new Set(["@eliotr/cloudflare-ai", "@eliotr/cloudflare-evidence", "@eliotr/cloudflare-research", "@eliotr/cloudflare-workflows", "@eliotr/contracts", "@eliotr/domain", "@eliotr/research", "zod"])],
  ["packages/cloudflare-workflows", new Set(["@eliotr/contracts", "@eliotr/domain", "@eliotr/research", "@eliotr/cloudflare-evidence", "@eliotr/platform-cloudflare"])],
  ["packages/cloudflare-artifacts", new Set(["@eliotr/domain", "@eliotr/cloudflare-evidence", "@eliotr/cloudflare-navigation", "@eliotr/contracts", "@eliotr/platform-cloudflare", "@eliotr/cloudflare-workflows", "zod"])],
  ["packages/cloudflare-federation", new Set(["@eliotr/contracts", "@eliotr/interfaces"])],
  ["packages/cloudflare-ai", new Set([...MODEL_TRANSPORT_IMPORTS, "@eliotr/contracts", "@eliotr/platform-cloudflare", "@eliotr/cloudflare-projection", "@eliotr/cloudflare-projection/ai-search"])],
  ["packages/cloudflare-access", new Set(["@eliotr/platform-cloudflare"])],
  ["packages/cloudflare-workspace-mcp", new Set([...COMPUTER_AGENT_IMPORTS, "@eliotr/cloudflare-raw-ingest", "@eliotr/cloudflare-workflows", "@eliotr/interfaces", "@eliotr/cloudflare-access", "@eliotr/contracts", "@eliotr/platform-cloudflare", "zod"])],
  ["packages/cloudflare-raw-ingest", new Set(["@eliotr/contracts", "@eliotr/domain", "@eliotr/interfaces", "@eliotr/platform-cloudflare"])],
  ["packages/cloudflare-markdown", new Set(["@eliotr/platform-cloudflare"])],
  ["packages/cloudflare-erasure", new Set(["@eliotr/backup-o2", "@eliotr/contracts"])],
  ["packages/cloudflare-projection", new Set([
    "@eliotr/contracts",
    "@eliotr/platform-cloudflare",
    "@eliotr/retrieval",
  ])],
  ["packages/cloudflare-navigation", new Set(["@eliotr/cloudflare-evidence", "@eliotr/cloudflare-projection", "@eliotr/contracts", "@eliotr/domain", "@eliotr/interfaces", "@eliotr/platform-cloudflare", "@eliotr/retrieval"])],
  ["packages/cloudflare-evidence", new Set([
    "@eliotr/contracts",
    "@eliotr/domain",
    "@eliotr/platform-cloudflare",
    "@eliotr/policy",
    "@eliotr/retrieval",
  ])],
  ["packages/google-drive-exchange", new Set(["@eliotr/contracts", "@eliotr/domain", "@eliotr/policy"])],
  ["packages/interfaces", new Set(["@eliotr/contracts", "@eliotr/domain", "@eliotr/policy", "@eliotr/retrieval", "@eliotr/research", "@eliotr/google-drive-exchange"])],
  ["packages/testkit", new Set(["@eliotr/contracts", "@eliotr/domain", "@eliotr/policy", "@eliotr/retrieval", "@eliotr/research", "@eliotr/google-drive-exchange", "@eliotr/interfaces"])],
  ["packages/pwa-http-client", new Set(["@eliotr/contracts"])],
  ["packages/pwa-source-workspace", new Set(["@eliotr/contracts", "@eliotr/pwa-http-client"])],
  ["packages/pwa-research-workspace", new Set(["@eliotr/contracts", "@eliotr/pwa-http-client", "@eliotr/pwa-source-workspace"])],
  ["packages/pwa-knowledge-workspace", new Set(["@eliotr/contracts", "@eliotr/pwa-http-client", "@eliotr/pwa-source-workspace"])],
  ["apps/eliotr-pwa", new Set([...RESEARCH_UI_IMPORTS, "@eliotr/contracts", "@eliotr/pwa-http-client", "@eliotr/pwa-source-workspace", "@eliotr/pwa-source-workspace/navigation-expand-api", "@eliotr/pwa-research-workspace", "@eliotr/pwa-knowledge-workspace"])],
  ["apps/eliotr-core", new Set([
    "@eliotr/cloudflare-artifacts",
    "@eliotr/cloudflare-artifacts/artifact-draft-read-service.js",
    "@eliotr/cloudflare-artifacts/artifact-draft-reader.js",
    "@eliotr/cloudflare-artifacts/artifact-product-service.js",
    "@eliotr/cloudflare-artifacts/artifact-cow-section-revision-ports.js",
    "@eliotr/cloudflare-artifacts/artifact-product-input.js",
    "@eliotr/cloudflare-http-protocol",
    "@eliotr/cloudflare-http-protocol/http-route-inputs.js",
    "@eliotr/cloudflare-http-protocol/bounded-json.js",
    "@eliotr/cloudflare-http-protocol/http-request-error.js",
    "@eliotr/cloudflare-http-protocol/agent-task-inbox-input.js",
    "@eliotr/cloudflare-backup",
    "@eliotr/cloudflare-research-branches",
    "@eliotr/cloudflare-model-transport/model-gateway-provider-native-response.js",
    "@eliotr/cloudflare-model-transport/model-gateway-http-request.js",
    ...RESEARCH_CONFIGURATION_IMPORTS,
    ...RESEARCH_RUNTIME_IMPORTS,
    "@eliotr/cloudflare-search-probe",
    "@eliotr/cloudflare-erasure-operations",
    ...COMPUTER_AGENT_IMPORTS,
    ...WIKI_IMPORTS,
    ...WORKSPACE_CAPABILITY_IMPORTS,
    ...MODEL_CONTROL_IMPORTS,
    "@eliotr/cloudflare-native-models",
    "@eliotr/cloudflare-navigation/project-owner-contract.js",
    "@eliotr/cloudflare-navigation/project-owner-storage.js",
    "@eliotr/cloudflare-access",
    "@eliotr/cloudflare-workspace-mcp",
    "@eliotr/cloudflare-research",
    "@eliotr/cloudflare-research-stages",
    "@eliotr/cloudflare-workflows",
    "@eliotr/cloudflare-raw-ingest",
    "@eliotr/cloudflare-markdown",
    "@eliotr/cloudflare-navigation",
    "@eliotr/cloudflare-ai",
    "@eliotr/cloudflare-projection",
    "@eliotr/cloudflare-evidence",
    "@eliotr/cloudflare-federation",
    "@eliotr/cloudflare-erasure",
    "@eliotr/contracts",
    "@eliotr/domain",
    "@eliotr/policy",
    "@eliotr/retrieval",
    "@eliotr/research",
    "@eliotr/platform-cloudflare",
    "@eliotr/google-drive-exchange",
    "@eliotr/interfaces",
  ])],
]);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "dist-types", ".wrangler", ".git"].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if ([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs"].includes(extname(entry.name))) out.push(full);
  }
  return out;
}

function projectPath(file) {
  return relative(ROOT, file).split(sep).join("/");
}

function ownerFor(file) {
  const normalized = projectPath(file);
  return [...PACKAGE_RULES.keys()].find((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function importsOf(source) {
  const matches = source.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/g);
  return [...matches].map((match) => match[1]);
}

const errors = [];
for (const sourceRoot of SOURCE_ROOTS) {
  const fullRoot = join(ROOT, sourceRoot);
  for (const file of await walk(fullRoot)) {
    const owner = ownerFor(file);
    if (!owner) continue;
    const normalizedPath = projectPath(file);
    const source = await readFile(file, "utf8");
    for (const specifier of importsOf(source)) {
      const allowedHostToolImport = HOST_TOOL_IMPORTS.get(normalizedPath)?.has(specifier) === true;
      if (!allowedHostToolImport &&
          FORBIDDEN_IMPORTS.some((prefix) => specifier === prefix || specifier.startsWith(prefix))) {
        errors.push(`${normalizedPath} imports forbidden module ${specifier}`);
      }
      if (!specifier.startsWith("@eliotr/")) continue;
      const allowed = PACKAGE_RULES.get(owner);
      if (!allowed?.has(specifier)) {
        errors.push(`${normalizedPath} violates dependency direction with ${specifier}`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Package boundaries and forbidden imports: PASS");
}
