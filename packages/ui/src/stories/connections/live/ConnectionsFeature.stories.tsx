import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  ConnectionsFeature, IDLE_QUERIES,
  type ConnectionsFeatureProps, type ConnectionsRowQueries,
  type ConnectionsGrant,
} from "../../../features/connections/ConnectionsFeature";

/**
 * The meta is annotated with the exported props type rather than inferred from the component, so
 * declaration emit cannot reach into DTO shapes that the owner-api-client barrel does not export.
 */
const meta: Meta<ConnectionsFeatureProps> = {
  title: "Product/Connections/Live",
  component: ConnectionsFeature,
  args: { queries: IDLE_QUERIES },
  decorators: [(Story) => <div className="eliot-token-story"><Story /></div>],
};
export default meta;
type Story = StoryObj<typeof meta>;

export const ProviderEmptyList: Story = {
  args: { queries: { ...IDLE_QUERIES, providerConfig: "loaded" }, providerConfigurations: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Not configured")).toBeVisible();
    await expect(canvas.getByText("Model provider configuration").closest("li")).not.toHaveTextContent("Check failed");
  },
};

function allQueries(overrides: Partial<ConnectionsRowQueries> = {}): ConnectionsRowQueries {
  const base: ConnectionsRowQueries = {
    health: "loaded",
    session: "loaded",
    grant: "loaded",
    providerConfig: "loaded",
    projectModel: "loaded",
    providerModelUse: "loaded",
    researchReadiness: "loaded",
    googleTransport: "loaded",
    diagnostic: "loaded",
  };
  return { ...base, ...overrides };
}

const MODEL_REVISION = {
  configuration_ref: "rpmc-1",
  configuration_sha256: "a".repeat(64),
  created_at: "2026-10-09T12:00:00.000Z",
  qualification_state: "qualified",
  semantic_revision: { revision_ref: "rev-1", config_sha256: "b".repeat(64) },
  model_selections: [],
} as const;

const GRANTEE = {
  issuer: "https://example.cloudflareaccess.com",
  authentication_method: "service_token",
  subject: "subject-1.access",
} as const;

const GRANT: ConnectionsGrant = {
  protocol: "eliotr.project-client-grant.v1",
  grant_id: "grant-1",
  project_id: "proj-1",
  grantor_principal_ref: "grantor-1",
  revision: 1,
  state: "ACTIVE",
  grantee: GRANTEE,
  allowed_operations: ["run"],
  ingest_namespace_ids: [],
  created_at: "2026-10-09T12:00:00.000Z",
  updated_at: "2026-10-09T12:00:00.000Z",
  expires_at: "2026-12-09T12:00:00.000Z",
};

const PROVIDER_CONFIGURED = {
  operation_id: "0f9a7b6c-5d4e-4f3a-8b2c-1d0e9f8a7b6c",
  provider_id: "openrouter",
  alias: "eliotr-" + "a".repeat(48),
  provider_config_id: "cfg-1",
  status: "configured_not_qualified",
  failure_code: null,
  provider_http_status: null,
  created_at: "2026-10-09T12:00:00.000Z",
  updated_at: "2026-10-09T12:00:00.000Z",
} as const;

const MODEL_USE_SELECTED = {
  protocol: "eliotr.research.provider-key-model-use.v1",
  project_id: "proj-1",
  operation_id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  key_operation_id: "0f9a7b6c-5d4e-4f3a-8b2c-1d0e9f8a7b6c",
  state: "selected",
  phase: "complete",
  selected_configuration_ref: "rpmc-1",
  selection_revision: 3,
  failure_code: null,
  created_at: "2026-10-09T12:00:00.000Z",
  updated_at: "2026-10-09T12:02:00.000Z",
} as const;

const DIAGNOSTIC_CONFIRMED = {
  protocol: "eliotr.mcp.client-diagnostic.v1",
  status: "CONFIRMED",
  challenge_id: "challenge-1",
  issued_at: "2026-10-09T12:00:00.000Z",
  expires_at: "2026-10-09T12:05:00.000Z",
  observation_ref: "observation-1",
  observed_at: "2026-10-09T12:01:00.000Z",
  auth_profile: "managed-oauth",
  deployment_generation: "deploy-1",
  trace_id: "trace-1",
} as const;

const DIAGNOSTIC_ISSUED = {
  protocol: "eliotr.mcp.client-diagnostic.v1",
  status: "ISSUED",
  challenge_id: "challenge-1",
  issued_at: "2026-10-09T12:00:00.000Z",
  expires_at: "2026-10-09T12:05:00.000Z",
  auth_profile: "managed-oauth",
  deployment_generation: "deploy-1",
} as const;

const DIAGNOSTIC_EXPIRED = {
  protocol: "eliotr.mcp.client-diagnostic.v1",
  status: "EXPIRED",
  challenge_id: "challenge-1",
  issued_at: "2026-10-09T11:50:00.000Z",
  expires_at: "2026-10-09T11:55:00.000Z",
  auth_profile: "managed-oauth",
  deployment_generation: "deploy-1",
} as const;

const READINESS_READY = {
  run_readiness: "ready",
  readiness_reason: "QUALIFICATION_PROOFS_CURRENT",
  missing_fields: [],
  invalid_fields: [],
} as const;

const READINESS_LAZY = {
  run_readiness: "lazy_renewal",
  readiness_reason: "QUALIFICATION_RENEWAL_AT_RUN",
  missing_fields: [],
  invalid_fields: [],
} as const;

const READINESS_BLOCKED = {
  run_readiness: "blocked",
  readiness_reason: "CONFIGURATION_NOT_READY",
  missing_fields: ["question"],
  invalid_fields: ["scope"],
} as const;

const ALL_LOADED: ConnectionsFeatureProps = {
  queries: allQueries(),
  health: {
    ready: true,
    checked_at: "2026-10-09T12:00:00.000Z",
    google_external_transport: "gemini-mcp",
  },
  session: { client_class: "owner_pwa", expires_at: "2026-10-09T13:00:00.000Z" },
  grants: [GRANT],
  providerConfig: PROVIDER_CONFIGURED,
  projectModel: { protocol: "eliotr.research-project-model-configuration.v1", project_id: "proj-1", selection_revision: 3, selected: MODEL_REVISION, revisions: [MODEL_REVISION], next_cursor: null },
  providerModelUse: MODEL_USE_SELECTED,
  readiness: READINESS_READY,
  diagnostic: DIAGNOSTIC_CONFIRMED,
};

const IDLE: ConnectionsFeatureProps = { queries: IDLE_QUERIES };

const LOADING: ConnectionsFeatureProps = {
  queries: allQueries({
    health: "loading",
    session: "loading",
    grant: "loading",
    providerConfig: "loading",
    projectModel: "loading",
    providerModelUse: "loading",
    researchReadiness: "loading",
    googleTransport: "loading",
    diagnostic: "loading",
  }),
};

/** Only the diagnostic row fails. Every other row keeps its own loaded answer. */
const DEGRADED: ConnectionsFeatureProps = {
  ...ALL_LOADED,
  diagnostic: undefined,
  queries: allQueries({ diagnostic: "failed" }),
};

/** Only the provider configuration row fails. Health stays answered. */
const PROVIDER_FAILED: ConnectionsFeatureProps = {
  ...ALL_LOADED,
  providerConfig: undefined,
  queries: allQueries({ providerConfig: "failed" }),
};

export const Useful: Story = { args: ALL_LOADED };

export const Empty: Story = { args: IDLE };

export const Loading: Story = { args: LOADING };

export const Degraded: Story = { args: DEGRADED };

export const Failed: Story = { args: PROVIDER_FAILED };

export const LongRussian: Story = { args: { ...ALL_LOADED, locale: "ru" } };

export const LongRussianDark: Story = {
  args: { ...ALL_LOADED, locale: "ru" },
  decorators: [Story => <div data-theme="dark"><Story /></div>],
};

/** Health and configuration alone must never read as Connected. */
export const HealthIsNotConnection: Story = {
  args: {
    ...ALL_LOADED,
    diagnostic: undefined,
    queries: allQueries({ diagnostic: "idle" }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryByText("Client call observed")).not.toBeInTheDocument();
    expect(canvas.getAllByText("Not checked yet").length).toBe(1);
  },
};

/** A failed provider configuration must not be reported as a health failure. */
export const ProviderFailureIsNotHealth: Story = {
  args: PROVIDER_FAILED,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Server answered")).toBeInTheDocument();
    expect(canvas.getAllByText("Check could not complete").length).toBe(1);
  },
};

/** A model-use operation is not the same fact as model readiness. */
export const ModelUseIsNotReadiness: Story = {
  args: {
    ...ALL_LOADED,
    providerModelUse: {
      ...MODEL_USE_SELECTED,
      state: "blocked",
      phase: "native_qualify",
      selected_configuration_ref: null,
      selection_revision: null,
      failure_code: "QUALIFICATION_NO_EFFECT",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Operation blocked")).toBeInTheDocument();
    expect(canvas.getByText("Model qualified")).toBeInTheDocument();
  },
};

/** A lazy renewal permits a run after renewal and is not the same as blocked. */
export const ReadinessRenewalIsNotBlocked: Story = {
  args: { ...ALL_LOADED, readiness: READINESS_LAZY },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Renewal at run: qualification is renewed at the moment the run starts")).toBeInTheDocument();
    expect(canvas.queryByText("Blocked")).not.toBeInTheDocument();
  },
};

export const ReadinessBlocked: Story = {
  args: { ...ALL_LOADED, readiness: READINESS_BLOCKED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Blocked, the configuration is incomplete, fields: 2")).toBeInTheDocument();
  },
};

/** An explicit disabled routing is a configuration fact, not a failure. */
export const GoogleDisabledIsConfigured: Story = {
  args: { ...ALL_LOADED, health: { ready: true, checked_at: "2026-10-09T12:00:00.000Z", google_external_transport: "disabled" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Routing disabled")).toBeInTheDocument();
  },
};

export const DiagnosticIssued: Story = {
  args: { ...ALL_LOADED, diagnostic: DIAGNOSTIC_ISSUED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Challenge issued, awaiting callback")).toBeInTheDocument();
  },
};

export const DiagnosticExpired: Story = {
  args: { ...ALL_LOADED, diagnostic: DIAGNOSTIC_EXPIRED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Observation expired")).toBeInTheDocument();
  },
};

/** The Google row shows routing only. No authorization URL or secret is ever rendered. */
export const GoogleTransportIsRoutingOnly: Story = {
  args: ALL_LOADED,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Google routing uses the Gemini MCP service")).toBeInTheDocument();
    const text = canvasElement.textContent ?? "";
    expect(text.indexOf("accounts.google.com")).toBe(-1);
    expect(text.indexOf("authorizationUrl")).toBe(-1);
    expect(text.indexOf("client_secret")).toBe(-1);
  },
};

export const DetailsJourney: Story = {
  args: { ...ALL_LOADED, onOpenDiagnostics: () => {} },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryByText("Confirmed")).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Details" }));
    await expect(canvas.getByText("Confirmed")).toBeInTheDocument();
  },
};

export const TargetedRetryHierarchy: Story = {
  args: { ...ALL_LOADED, queries: allQueries({ providerConfig: 'failed' }), onRefresh: fn(), onRetry: fn(), onRetryRow: fn(), onOpenDiagnostics: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    expect(canvasElement.querySelectorAll('.connections-feature__actions .er-button--primary')).toHaveLength(1);
    const row = canvas.getByText('Model provider configuration').closest('li');
    if (row === null) throw new Error('Provider row did not render');
    await userEvent.click(within(row).getByRole('button', { name: 'Check again' }));
    expect(args.onRetryRow).toHaveBeenCalledTimes(1);
    expect(args.onRetryRow).toHaveBeenCalledWith('providerConfig');
    expect(args.onRefresh).not.toHaveBeenCalled();
    expect(args.onRetry).not.toHaveBeenCalled();
    expect(args.onOpenDiagnostics).not.toHaveBeenCalled();
    expect(canvasElement.querySelectorAll('[role="status"], [aria-live]')).toHaveLength(0);
  },
};
