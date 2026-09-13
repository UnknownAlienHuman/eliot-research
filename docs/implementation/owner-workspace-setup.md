# Owner workspace setup

Use this sequence to create the first owner workspace.

1. Obtain an operator-selected namespace bootstrap profile from the native
   authority/configuration record. Do not invent a principal, permission,
   expiry, provenance reference, or policy value.
2. Install ELIOTR_NAMESPACE_BOOTSTRAP_PROFILES_JSON either as a standalone
   environment value or as the only variable in the vars object of
   .eliotr-state/research-runtime.json. The runtime envelope supports this
   standalone setup, so model/profile/spend values are not required just to
   create a workspace.
3. The envelope protocol is eliotr.research-runtime.v1. The profile document
   protocol is eliotr.namespace-bootstrap-profiles.v1 and its top-level
   profiles array contains at most 16 entries with no duplicate profile refs.
4. Select the profile in Sources -> Choose/Create, then use Add document with
   that namespace. The profile is an input to creation, not browser authority.
Each profile has these exact fields:

* profile_ref: VersionedRef with an identifier id and positive safe-integer revision.
* title: a non-empty, trimmed string of at most 120 characters without control characters.
* principal_ref, credential_generation, and provenance_ref: bounded identifier strings.
* expires_at: canonical UTC ISO-8601 with millisecond precision.
* policy: the local namespace policy described below.
* owner_read_scope: the explicit initial owner read grant described below.
The policy contains only the fields used by the native local namespace
validator: allowed_ownership_modes must be exactly immutable_import;
source_class is an identifier; assurance_ceiling is LOCATOR_ONLY, CAPTURED, or
QUALIFIED; instruction_taint is DATA_ONLY; and allowed_effects is READ_ONLY.
It also contains allowed_use, disclosure_ceiling, license_policy_ref,
default_storage_policy, default_residency_profile_id, default_retention_policy_id,
and minimum_quality_state.

For this bootstrap profile, allowed_use is a unique bounded identifier list
that includes research, default_storage_policy is NORMALIZED_CLOUD_ONLY, and
minimum_quality_state is high_fidelity, standard, or degraded. The policy
does not contain a source namespace or owner reference; the service computes
those from the authenticated owner and the new namespace.

owner_read_scope.allowed_use is also a unique bounded identifier list of at
most 16 entries and must include research. Its disclosure_ceiling must equal
policy.disclosure_ceiling, and policy.allowed_use must be a subset of it.
Its canonical expires_at must be no later than the profile expiry.
Both expiries are checked against the current authority clock on use.

Bootstrap creates only a new namespace's ownership record, admission policy,
and generation-one owner read scope in one authoritative operation. It does
not create a source, source revision, admission receipt, or document content.
The installed profile and read grant are rechecked for current identity and
expiry; an expired or differently assigned profile fails closed.

After the namespace is created, Add document follows the separate capture and
admission flow. A successful profile installation therefore does not prove
that a document exists, that a source revision is admitted, or that a live
Worker, D1, R2, or external provider is ready.

See [Research runtime configuration](research-runtime-configuration.md) for the
envelope path, canonicalization, environment conflict rules, and the
installed-versus-live boundary. The parser and typed reader are in
apps/eliotr-core/src/source-namespace-bootstrap-profiles.ts.
