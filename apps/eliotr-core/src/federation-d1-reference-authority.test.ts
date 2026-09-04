import type {
  AllowedReferenceManifest,
  ScopeSnapshot,
  VersionedRef,
} from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import {
  FederationD1ReferenceAuthorityError,
  createD1FederationReferenceAuthorities,
} from "./federation-d1-reference-authority.js";
import {
  canonicalFederationJson,
  federationSha256Hex,
} from "./federation-service.js";

const NOW = "2026-09-04T13:40:00.000Z";
const EXPIRES = "2026-09-05T13:40:00.000Z";
const SCOPE_REF: VersionedRef = { id: "scope-snapshot-1", revision: 1 };
const MANIFEST_REF: VersionedRef = {
  id: "allowed-reference-manifest-1",
  revision: 1,
};

type Row = Record<string, unknown>;

class D1ReadFixture {
  public manifestRow: Row | null = null;
  public scopeRow: Row | null = null;
  public failRead = false;
  public calls = 0;
  public readonly database: D1Database;

  public constructor() {
    this.database = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          first: async <T>(): Promise<T | null> => {
            this.calls += 1;
            if (this.failRead) throw new Error("fixture D1 read failed");
            const selected = sql.includes(
              "federation_allowed_reference_manifest_authority",
            )
              ? this.manifestRow
              : this.scopeRow;
            if (selected === null) return null;
            const id = sql.includes(
              "federation_allowed_reference_manifest_authority",
            )
              ? selected.manifest_id
              : selected.snapshot_id;
            if (id !== values[0] || selected.revision !== values[1]) return null;
            return structuredClone(selected) as T;
          },
        }),
      }),
    } as unknown as D1Database;
  }
}

async function scopeSnapshot(
  overrides: Partial<Omit<ScopeSnapshot, "digest">> = {},
): Promise<ScopeSnapshot> {
  const payload: Omit<ScopeSnapshot, "digest"> = {
    snapshot_id: SCOPE_REF.id,
    revision: SCOPE_REF.revision,
    resolved_scope_expression: { kind: "PROJECT", project_id: "project-1" },
    participant_generations: {
      "client-principal": "client-credential-generation-1",
      "server-principal": "server-credential-generation-1",
    },
    member_source_revision_refs: ["source-revision-1@1"],
    source_owner_generations: {
      "source-revision-1@1": "source-owner-generation-1",
    },
    policy_authority_ref: "privacy-policy-1",
    disclosure_closure_digest: "c".repeat(64),
    purge_ledger_revision: 7,
    client_fence_ref: "client-fence-1",
    created_at: NOW,
    expires_at: EXPIRES,
    ...overrides,
  };
  return {
    ...payload,
    digest: await federationSha256Hex(canonicalFederationJson(payload)),
  };
}

async function manifest(
  overrides: Partial<Omit<AllowedReferenceManifest, "manifest_digest">> = {},
): Promise<AllowedReferenceManifest> {
  const payload: Omit<AllowedReferenceManifest, "manifest_digest"> = {
    manifest_ref: MANIFEST_REF,
    scope_snapshot_ref: SCOPE_REF,
    allowed_source_revision_refs: [
      { id: "source-revision-1", revision: 1 },
    ],
    allowed_evidence_handle_refs: [
      { id: "evidence-handle-1", revision: 1 },
    ],
    allowed_tool_definition_refs: [],
    allowed_verifier_refs: [],
    permitted_anchor_and_precision_ceilings: [],
    provider_and_policy_generations: {
      "client-principal": "client-credential-generation-1",
      "server-principal": "server-credential-generation-1",
      "privacy-policy-1": "privacy-generation-1",
    },
    stale_or_revoked_entries: [],
    permitted_acquisition_or_expansion_routes: [],
    disclosure_ceiling: "private",
    allowed_use: ["federation.submit"],
    expires_at: EXPIRES,
    client_fence_ref: "client-fence-1",
    ...overrides,
  };
  return {
    ...payload,
    manifest_digest: await federationSha256Hex(
      canonicalFederationJson(payload),
    ),
  };
}

async function rows(): Promise<{
  readonly scope: ScopeSnapshot;
  readonly manifest: AllowedReferenceManifest;
  readonly scopeRow: Row;
  readonly manifestRow: Row;
}> {
  const scope = await scopeSnapshot();
  const admittedManifest = await manifest();
  return {
    scope,
    manifest: admittedManifest,
    scopeRow: {
      snapshot_id: scope.snapshot_id,
      revision: scope.revision,
      digest: scope.digest,
      client_fence_ref: scope.client_fence_ref,
      policy_authority_ref: scope.policy_authority_ref,
      purge_ledger_revision: scope.purge_ledger_revision,
      created_at: scope.created_at,
      expires_at: scope.expires_at,
      snapshot_json: canonicalFederationJson(scope),
      stored_at: NOW,
    },
    manifestRow: {
      manifest_id: admittedManifest.manifest_ref.id,
      revision: admittedManifest.manifest_ref.revision,
      manifest_digest: admittedManifest.manifest_digest,
      scope_snapshot_id: admittedManifest.scope_snapshot_ref.id,
      scope_snapshot_revision: admittedManifest.scope_snapshot_ref.revision,
      client_fence_ref: admittedManifest.client_fence_ref,
      expires_at: admittedManifest.expires_at,
      manifest_json: canonicalFederationJson(admittedManifest),
      stored_at: NOW,
    },
  };
}

function expectedError(code: string) {
  return expect.objectContaining({
    name: "FederationD1ReferenceAuthorityError",
    code,
  });
}

describe("D1 federation reference authorities", () => {
  it("returns exact strictly decoded manifest and ScopeSnapshot revisions", async () => {
    const fixture = new D1ReadFixture();
    const authorityRows = await rows();
    fixture.manifestRow = authorityRows.manifestRow;
    fixture.scopeRow = authorityRows.scopeRow;
    const authority = createD1FederationReferenceAuthorities(fixture.database);

    await expect(authority.manifests.get(MANIFEST_REF)).resolves.toEqual(
      authorityRows.manifest,
    );
    await expect(authority.scopes.get(SCOPE_REF)).resolves.toEqual(
      authorityRows.scope,
    );
    expect(fixture.calls).toBe(2);
  });

  it("returns null for an absent exact revision without widening the lookup", async () => {
    const fixture = new D1ReadFixture();
    const authority = createD1FederationReferenceAuthorities(fixture.database);

    await expect(authority.manifests.get(MANIFEST_REF)).resolves.toBeNull();
    await expect(authority.scopes.get(SCOPE_REF)).resolves.toBeNull();
    expect(fixture.calls).toBe(2);
  });

  it("rejects noncanonical authority JSON", async () => {
    const fixture = new D1ReadFixture();
    const authorityRows = await rows();
    fixture.manifestRow = {
      ...authorityRows.manifestRow,
      manifest_json: JSON.stringify(authorityRows.manifest, null, 2),
    };
    const authority = createD1FederationReferenceAuthorities(fixture.database);

    await expect(authority.manifests.get(MANIFEST_REF)).rejects.toEqual(
      expectedError("FEDERATION_REFERENCE_READBACK_INVALID"),
    );
  });

  it("rejects digest mismatch before returning strict objects", async () => {
    const fixture = new D1ReadFixture();
    const authorityRows = await rows();
    fixture.scopeRow = {
      ...authorityRows.scopeRow,
      digest: "0".repeat(64),
    };
    const authority = createD1FederationReferenceAuthorities(fixture.database);

    await expect(authority.scopes.get(SCOPE_REF)).rejects.toEqual(
      expectedError("FEDERATION_REFERENCE_READBACK_INVALID"),
    );
  });

  it("rejects row and JSON identity or client-fence drift", async () => {
    const fixture = new D1ReadFixture();
    const authorityRows = await rows();
    fixture.manifestRow = {
      ...authorityRows.manifestRow,
      client_fence_ref: "other-client-fence",
    };
    const authority = createD1FederationReferenceAuthorities(fixture.database);

    await expect(authority.manifests.get(MANIFEST_REF)).rejects.toEqual(
      expectedError("FEDERATION_REFERENCE_READBACK_INVALID"),
    );
  });

  it("rejects unknown authority-shaped D1 columns", async () => {
    const fixture = new D1ReadFixture();
    const authorityRows = await rows();
    fixture.scopeRow = {
      ...authorityRows.scopeRow,
      authorization_override: "forged",
    };
    const authority = createD1FederationReferenceAuthorities(fixture.database);

    await expect(authority.scopes.get(SCOPE_REF)).rejects.toEqual(
      expectedError("FEDERATION_REFERENCE_READBACK_INVALID"),
    );
  });

  it("rejects malformed references before D1 access", async () => {
    const fixture = new D1ReadFixture();
    const authority = createD1FederationReferenceAuthorities(fixture.database);

    await expect(
      authority.manifests.get({ id: "bad id", revision: 1 }),
    ).rejects.toEqual(expectedError("FEDERATION_REFERENCE_INPUT_INVALID"));
    expect(fixture.calls).toBe(0);
  });

  it("classifies D1 transport failure as retryable read failure", async () => {
    const fixture = new D1ReadFixture();
    fixture.failRead = true;
    const authority = createD1FederationReferenceAuthorities(fixture.database);

    await expect(authority.scopes.get(SCOPE_REF)).rejects.toEqual(
      expect.objectContaining({
        code: "FEDERATION_REFERENCE_READ_FAILED",
        retryable: true,
      }),
    );
  });

  it("rejects an invalid CORE_DB binding at composition time", () => {
    expect(() =>
      createD1FederationReferenceAuthorities({} as D1Database),
    ).toThrow(FederationD1ReferenceAuthorityError);
  });
});
