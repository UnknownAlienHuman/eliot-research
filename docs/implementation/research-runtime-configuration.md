# Research runtime configuration

The research Worker receives its server-owned semantic configuration from one
operator-installed envelope. Use this same envelope for local launch,
Cloudflare foundation generation, and deployment readback. It keeps the
configuration values and their provenance references together; it does not
grant access, select a provider, or prove that a remote resource is live.

## Canonical file and shape

The default file is:

    .eliotr-state/research-runtime.json

The path is resolved relative to the repository root when it is relative. Set
ELIOTR_RESEARCH_CONFIG_FILE in the invoking process to use another file. An
explicit path must exist; an absent default file leaves the invoking
environment unchanged. The Core server refuses new semantic research when
required configuration is missing or invalid, while other owner surfaces
remain available. Existing environment-based configuration is still supported.

The following is shape notation, not a runnable configuration. Replace every
typed placeholder with an exact operator-installed value from the native
authority/configuration source.

~~~text
{
  protocol: "eliotr.research-runtime.v1",
  vars: {
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: <semantic configuration object>,
    ELIOTR_MODEL_PROFILE_DEFINITION_JSON: <model profile definition object>,
    ELIOTR_MODEL_PROFILE_PROVENANCE_REF: <profile provenance reference>,
    ELIOTR_MODEL_SPEND_POLICY_JSON: <spend policy object>,
    ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: <spend policy provenance reference>,
    ELIOTR_RESEARCH_REPORT_CONFIG_JSON: <report configuration object>,
    ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: <report policy provenance reference>,
    ELIOTR_WORKSPACE_OWNER_BINDINGS_JSON: <optional installed binding object>,
    ELIOTR_NAMESPACE_BOOTSTRAP_PROFILES_JSON: <optional namespace creation profiles>
  }
}
~~~

The envelope has exactly the two top-level keys protocol and vars. The
protocol is exactly eliotr.research-runtime.v1. The vars object may contain
only the keys listed below. Do not add environment names, credentials, bearer
tokens, cookies, URLs containing secrets, or ad-hoc approval fields.

The seven research model/report variables form one group: supply all seven
when configuring research. A file containing only Workspace bindings or
namespace creation profiles is valid, so document setup does not require
model configuration first. At least one supported variable is required.

| Key | Required for research | Native validation and meaning |
| --- | --- | --- |
| ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON | Yes | Strictly parsed by ConfigurationSchema in apps/eliotr-core/src/research-semantic-server.ts, including the synthesis/audit configuration and normalization binding. |
| ELIOTR_MODEL_PROFILE_DEFINITION_JSON | Yes | Parsed and bound through packages/cloudflare-research/src/research-model-profile-config.ts and its persisted profile authority. It must describe an installed profile; no model is supplied by a default. |
| ELIOTR_MODEL_PROFILE_PROVENANCE_REF | Yes | The exact provenance reference matched by the profile binding source and its current persisted authority. |
| ELIOTR_MODEL_SPEND_POLICY_JSON | Yes | Parsed by readResearchModelSpendPolicy in packages/cloudflare-research/src/research-model-spend-policy.ts; current principal, credential, deployment, and policy authority are checked by Core. |
| ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF | Yes | The exact provenance reference required by the spend-policy reader. A body value or bare digest is not spend authorization. |
| ELIOTR_RESEARCH_REPORT_CONFIG_JSON | Yes | Parsed through createResearchReportConfigSource in packages/cloudflare-research/src/research-report-config.ts; report policy and artifact rules remain server-owned. |
| ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF | Yes | The exact report-policy provenance reference matched by the report configuration source. |
| ELIOTR_WORKSPACE_OWNER_BINDINGS_JSON | No | When present, parsed by parseWorkspaceOwnerBindings using protocol eliotr.workspace-owner-bindings.v1. Each cross-principal rule must carry its exact owner/MCP identities, credential and deployment generation, auth profile, source namespace, expiry, and provenance. There is no default binding; a request body, hash, or capture identity cannot replace an installed rule. |
| ELIOTR_NAMESPACE_BOOTSTRAP_PROFILES_JSON | No | Parsed by parseNamespaceBootstrapProfiles using protocol eliotr.namespace-bootstrap-profiles.v1. Installed profiles bind the current owner principal and credential to an expiring policy for new immutable-import namespaces. An explicit owner_read_scope supplies the initial read permission so admitted documents can appear in Library. Creation initializes ownership, admission policy, and that exact read scope atomically; document admission remains separate. |

For keys ending in _JSON, the loader accepts an object or a JSON string that
decodes to an object. It recursively canonicalizes object keys and rejects a
canonical value over 65,536 bytes. Non-JSON references are non-empty strings
of at most 256 characters using the loader's identifier character set. The
whole file is limited to 1 MiB. Unknown keys, an incomplete research group, malformed
JSON, and malformed references fail closed.

If a listed key is already present in the process environment, its value must
equal the file value after the loader's canonical JSON normalization. A
different ambient value is a configuration conflict, not an override. Remove
the conflict or install the exact same value before invoking a launch,
provision, or deployment entrypoint.

## How values reach the Worker

The existing call sites use the same loader:

* scripts/lib/local-launch.mjs loads the envelope before generating the local
  Wrangler configuration and forwards the allowlisted values into the
  generated local Worker variables. Local development isolation and disabled
  remote provider bindings remain in force.
* scripts/provision-cloudflare-core.mjs loads the envelope before building
  apps/eliotr-core/wrangler.deploy.jsonc. It copies each allowlisted value
  exactly and removes an absent optional value rather than inventing one.
  Its check-only path validates the generated configuration before any
  provisioning decision.
* scripts/deploy-cloudflare.mjs loads the envelope and verifies the
  generated deployment configuration has the same allowlisted values before
  the deployment path can proceed. A generated file by itself is not a live
  deployment receipt.

Install the envelope first, then use the existing entrypoint for the intended
environment. Treat a loader error, Core schema error, provenance mismatch, or
generated-config drift as a failed configuration step. Do not work around it by
copying values into another env file or by adding an unrecognized variable.

## Install a model authority

Compile the explicit owner setup into the seven Worker variables first:

    node scripts/configure-research-runtime.mjs .eliotr-state/owner-setup.json

The input uses `protocol: "eliotr.research-owner-setup.v1"` and the typed
`semantic`, `model_profile`, `spend_policy`, and `report` fields from
`apps/eliotr-core/src/research-owner-runtime-config.ts`. The compiler supplies
the production prompts, output schemas, and canonical profile identity. The
owner entrypoint selects `model_profile_ref: "research-model-v1"`. Routes,
prices, approved spending, owner identity and policy expiry remain explicit
operator decisions. Existing workspace and namespace settings are preserved.
Compilation does not deploy the Worker or invoke a model.

The operator installer uses the generated Wrangler configuration only for the
Cloudflare account and `CORE_DB` identity. It reads the bearer from the official
Wrangler browser OAuth profile and never accepts or prints a token:

    node scripts/install-research-model-authority.mjs prepare --input model-prepare.json --config apps/eliotr-core/wrangler.deploy.jsonc

`prepare` installs the explicit pricing snapshot and provisions the exact route,
then prints a preparation receipt containing the provider route identity. After
an independent provider probe produces real `tier: "LIVE"` evidence, run:

    node scripts/install-research-model-authority.mjs install --input model-install.json --config apps/eliotr-core/wrangler.deploy.jsonc

The install input must carry the same reviewed provisioning/pricing values plus
that LIVE qualification and `environment: "PRODUCTION"` promotion options. No
model, price, limit, qualification, or spend authority is inferred from the
Wrangler file.

## Installed versus live

Installed configuration means the loader accepted the envelope and the Core
server accepted its strict native schemas and provenance bindings. It may also
mean that a generated Wrangler file contains the values. This proves
configuration transport and validation only.

Live readiness requires fresh server-owned reads and the relevant preflight or
deployment readback: current D1 profile/deployment/pricing and verifier
qualification, current navigation/grants, the intended Worker and bindings,
and the external provider or Access behavior required by the selected
surface. The runtime file cannot mint those authorities, turn a route LIVE,
or establish billing approval. A workspace binding likewise does not prove
that the current capture, namespace, ledger, or source is readable; the
workspace admission path rechecks those facts.
