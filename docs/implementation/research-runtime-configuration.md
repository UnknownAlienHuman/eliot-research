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
the production prompts and output schemas, computes each deployment's
`parameters_digest` from those fixed semantic request parameters, and generates
the profile definition digest and reference. `parameters_digest` may therefore
be omitted from the input. If it is present, it must equal the computed value;
a conflicting value is rejected. The owner entrypoint requires
`model_profile_ref: "research-model-v1"`. Routes, route versions, generations,
pricing references, quotes, approved spending, owner identity and policy expiry
remain explicit operator decisions. Existing workspace and namespace settings
are preserved. Compilation does not deploy the Worker or invoke a model.

Before installation, plan each explicit model stage from the pinned production
assets:

    node scripts/plan-research-model-route.mjs INPUT.json [--output PATH]

The input has six required fields: `route_ref`, `route_version`,
`pricing_snapshot_ref`, `stage` (`SYNTHESIZE` or `AUDIT_CLAIMS`), `max_tokens`,
and `route_definition` (the non-empty Cloudflare element array, without an
`elements` wrapper). Optional `output_format` selects `json_schema` (the existing
default) or `prompt_json`. The latter omits provider `response_format` and adds the
complete canonical output schema to the trusted prompt. Both prompt and parameter
digests describe that actual request; server-side synthesis and audit decoders
remain strict. The owner document preset and semantic setup accept the same mode.
The local-only plan records the exact compiled provider
route name, prompt/schema generations, parameter digest, and route-definition
hash. It does not install pricing, approve spending, assert `LIVE` qualification,
provision a route, or call a model. For the ordinary owner document preset,
`createResearchOwnerDocumentPreset` supplies the pinned prompts and schemas and
the neutral Russian report presentation (`Ответ по документам`) with an
observation-only `UNRESOLVED` default until audit; authority inputs remain
explicit.

The configuration CLI also accepts `protocol:
"eliotr.research-owner-document-setup.v1"` with exactly `document_preset`,
`model_profile`, `spend_policy`, and `report_admission_policy` alongside that
protocol. `document_preset` is the input to `createResearchOwnerDocumentPreset`.
The CLI generates the ordinary Russian document report policy and semantic
configuration, then validates them through the same full runtime compiler.

If the exact route was already deployed from the Cloudflare dashboard, bind it
to the generated plan before preparation:

    node scripts/install-research-model-authority.mjs adopt --input PLAN.json --provider-route-id ID

Adoption reads the actual route, element array and active deployment from the
Cloudflare management API, persists their immutable D1 binding, then repeats
the provider readback. It neither changes the provider route nor supplies LIVE
qualification. Dashboard login alone does not give Wrangler OAuth the API
permissions needed by this command.

`qualifyDynamicRouteGeneration` obtains LIVE evidence only from an observed
model response and exact provider readback. Migration `0054` and
`createD1ResearchModelQualificationObservationStore` commit a claim before that
call. A repeated request reads a completed receipt; an unfinished or uncertain
claim never automatically invokes the provider again. Bootstrap output is
bounded and stored immutably in the private work bucket, separately from
workflow attempts and user reports.

The operator command connects that mechanism to the existing production resources:

    node scripts/install-research-model-authority.mjs qualify --input qualification-request.json --gateway-oauth-client-id CLIENT_ID

Its strict input is `{ "protocol": "eliotr.research-model-qualification-request.v1",
"probe": <DynamicRouteQualificationProbeInput>, "prompt": <ResearchQualificationPromptConfig> }`.
The probe contains the actual preparation receipt, exact route definition, selected provider/model,
real EvidencePack, explicit request bounds, one idempotency identity and the qualification window.
The prompt configuration contains the owner access identity, reference policy, manifest reference,
manifest residency domains, trusted prompt parameters and request timeout. These values are explicit
operator input; neither an empty ORIENT pack nor a fabricated workflow receipt supplies evidence.

`qualify` validates its local input before OAuth. Wrangler remote bindings connect the configured
CORE_DB, SEARCH_DB, EVIDENCE_BUCKET, WORK_BUCKET and AI. The command reuses current scope/grant
checks, the D1/R2 evidence resolver and the ordinary evidence-context prompt compiler. Its private
immutable qualification manifest has no W2 attempt dependency, which allows the first provider call
before a model profile becomes ACTIVE. The existing pricing approval and one-call claim remain
required. The command prints only the actual qualification result; installation/promotion is a
separate operation. Temporary runtime configuration contains resource identities only and is removed
after disposal; the production Worker configuration is not rewritten. The temporary
remote preview has a unique name so it does not reuse the application's Access
hostname. Account-wide preview Access policies still apply.

On 2026-09-13 the owner selected OpenRouter `thinkingmachines/inkling:free` and
installed its BYOK key under alias `default` in `eliotr-reasoning`. The synthesis
and audit routes for `owner-inkling-free-v1` were created and their active versions
read back through Cloudflare MCP. This provider requires `prompt_json`: its
[official model page](https://openrouter.ai/thinkingmachines/inkling:free) lists
no `response_format` support. The same page says prompts and outputs are logged
for model improvement and prohibits confidential or personal data on this free
endpoint. Initial qualification uses the public project README. Published routes
are configuration evidence, not proof of a completed model response or report.

The setup input has this complete minimum shape. It is notation rather than a
runnable file: every placeholder must be replaced by the corresponding
operator-installed value, and the policy/quote objects must satisfy their
native strict schemas.

~~~text
{
  protocol: "eliotr.research-owner-setup.v1",
  semantic: {
    synthesis: { max_tokens: <positive integer>, request_timeout_ms: <positive integer> },
    audit: {
      max_tokens: <positive integer>, request_timeout_ms: <positive integer>,
      verifier_ref: <installed verifier reference>,
      verifier_schema_generation: <installed verifier schema generation>,
      allowed_verifier_refs: [<installed verifier reference>],
      policy: <explicit claim-audit policy>
    },
    normalization: {
      section_ref: { id: <installed section id>, revision: <positive integer> },
      required_precision: <explicit precision>,
      required_source_class: <explicit source class>
    }
  },
  model_profile: {
    config_provenance_ref: <explicit profile provenance reference>,
    model_profile_ref: "research-model-v1",
    expires_at: <canonical UTC time>,
    max_context_bytes: <positive integer>,
    deployment: {
      route_ref: <explicit application route>,
      route_version: <explicit route version>,
      prompt_generation: <explicit prompt generation>,
      schema_generation: <explicit schema generation>,
      pricing_snapshot_ref: <explicit pricing snapshot reference>,
      parameters_digest: <optional SHA-256; omit to compute>
    },
    policy: <explicit profile policy>
  },
  spend_policy: {
    protocol: "eliotr.research-model-spend-policy.v1",
    approved: true,
    policy_ref: <explicit spend policy reference>,
    config_provenance_ref: <explicit spend policy provenance reference>,
    principal_ref: <explicit owner principal>, client_class: "owner_pwa",
    credential_generation: <explicit credential generation>,
    deployment_generation: <explicit deployment generation>,
    policy_generation: <explicit policy generation>,
    policy_authority_ref: <explicit policy authority reference>,
    expires_at: <canonical UTC time>,
    rules: [
      {
        stage: "SYNTHESIZE",
        deployment: <explicit deployment with the fields above; digest optional>,
        max_input_bytes: <positive integer>, max_output_bytes: <positive integer>,
        quote: <explicit quote object>
      },
      {
        stage: "AUDIT_CLAIMS",
        deployment: <explicit deployment with the fields above; digest optional>,
        max_input_bytes: <positive integer>, max_output_bytes: <positive integer>,
        quote: <explicit quote object>
      }
    ]
  },
  report: {
    admission_policy: <explicit report admission policy>,
    artifact_policy: <explicit report artifact policy>
  }
}
~~~

The two spend rules must remain explicit and complete; only their computed
parameter hashes are derived. The profile definition's `definition_sha256` and
`definition_ref` are generated by the compiler and are never input fields.

The authenticated owner configuration endpoint rejects an expired profile,
report or spend policy, and marks a spend policy bound to another owner session
or deployment as invalid. This is a configuration/currentness result, not
proof that a provider call has executed.

An installed setup is not unconditionally reusable across documents or scopes.
Each orientation computes `policy_authority_ref` from the current access,
policy rows and member policy closures, and `policy_generation` is derived from
that authority. Reuse across scopes is valid only when those values and the
principal, credential generation and deployment still match the installed
spend policy; a changed policy closure or a normal login with a new credential
generation requires a fresh explicit configuration.

The prepare/install/adopt commands use the generated Wrangler configuration for the
Cloudflare account and `CORE_DB` identity; qualification also reads the five resource bindings
listed above and the reasoning gateway URL. The installer reads the bearer from the official
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
