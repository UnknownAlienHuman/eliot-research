import type {
  AllowedReferenceManifest,
  ScopeSnapshot,
} from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import {
  FederationD1ReferenceAdmissionError,
  createD1FederationReferenceAuthorityStore,
} from "./federation-d1-reference-admission.js";
import {
  canonicalFederationJson,
  federationSha256Hex,
} from "./federation-service.js";

const NOW = "2026-09-04T14:00:00.000Z";
const EXPIRES = "2026-09-05T14:00:00.000Z";
type WriteMode = "normal" | "throw-before" | "throw-after";
type Row = Record<string, unknown>;

function key(id: unknown, revision: unknown): string {
  return `${String(id)}@${String(revision)}`;
}

class D1AdmissionFixture {
  public readonly scopes = new Map<string, Row>();
  public readonly manifests = new Map<string, Row>();
  public writeMode: WriteMode = "normal";
  public writeAttempts = 0;
  public mutations = 0;
  public readonly database: D1Database;

  public constructor() {
    this.database = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          first: async <T>(): Promise<T | null> =>
            this.execute(sql, values) as T | null,
        }),
      }),
    } as unknown as D1Database;
  }

  private execute(sql: string, values: readonly unknown[]): Row | null {
    if (sql.startsWith("SELECT ")) {
      const table = sql.includes(
        "federation_allowed_reference_manifest_authority",
      )
        ? this.manifests
        : this.scopes;
      const row = table.get(key(values[0], values[1]));
      return row === undefined ? null : structuredClone(row);
    }
    if (sql.startsWith("INSERT INTO federation_scope_snapshot_authority")) {
      return this.insertScope(values);
    }
    if (
      sql.startsWith(
        "INSERT INTO federation_allowed_reference_manifest_authority",
      )
    ) {
      return this.insertManifest(values);
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  private beforeWrite(): void {
    this.writeAttempts += 1;
    if (this.writeMode === "throw-before") {
      this.writeMode = "normal";
      throw new Error("fixture failed before D1 mutation");
    }
  }

  private afterWrite(row: Row): Row {
    if (this.writeMode === "throw-after") {
      this.writeMode = "normal";
      throw new Error("fixture lost D1 acknowledgement");
    }
    return structuredClone(row);
  }

  private insertScope(values: readonly unknown[]): Row | null {
    this.beforeWrite();
    const identity = key(values[0], values[1]);
    if (this.scopes.has(identity)) return null;
    const row: Row = {
      snapshot_id: values[0],
      revision: values[1],
      digest: values[2],
      client_fence_ref: values[3],
      policy_authority_ref: values[4],
      purge_ledger_revision: values[5],
      created_at: values[6],
      expires_at: values[7],
      snapshot_json: values[8],
      stored_at: values[9],
    };
    this.scopes.set(identity, row);
    this.mutations += 1;
    return this.afterWrite({ snapshot_id: values[0] });
  }

  private insertManifest(values: readonly unknown[]): Row | null {
    this.beforeWrite();
    const identity = key(values[0], values[1]);
    if (this.manifests.has(identity)) return null;
    const row: Row = {
      manifest_id: values[0],
      revision: values[1],
      manifest_digest: values[2],
      scope_snapshot_id: values[3],
      scope_snapshot_revision: values[4],
      client_fence_ref: values[5],
      expires_at: values[6],
      manifest_json: values[7],
      stored_at: values[8],
    };
    this.manifests.set(identity, row);
    this.mutations += 1;
    return this.afterWrite({ manifest_id: values[0] });
  }
}

async function scopeSnapshot(
  overrides: Partial<Omit<ScopeSnapshot, "digest">> = {},
): Promise<ScopeSnapshot> {
  const payload: Omit<ScopeSnapshot, "digest"> = {
    snapshot_id: "scope-snapshot-1",
    revision: 1,
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
    manifest_ref: { id: "allowed-reference-manifest-1", revision: 1 },
    scope_snapshot_ref: { id: "scope-snapshot-1", revision: 1 },
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

function store(fixture: D1AdmissionFixture) {
  return createD1FederationReferenceAuthorityStore(fixture.database, {
    now: () => NOW,
  });
}

function expectedError(code: string) {
  return expect.objectContaining({
    name: "FederationD1ReferenceAdmissionError",
    code,
  });
}

describe("D1 federation reference authority admission", () => {
  it("creates and exactly replays one immutable ScopeSnapshot revision", async () => {
    const fixture = new D1AdmissionFixture();
    const authority = store(fixture);
    const snapshot = await scopeSnapshot();

    await expect(authority.admitScopeSnapshot(snapshot)).resolves.toEqual({
      kind: "SCOPE_SNAPSHOT",
      outcome: "CREATED",
      ref: { id: snapshot.snapshot_id, revision: snapshot.revision },
      digest: snapshot.digest,
    });
    await expect(authority.admitScopeSnapshot(snapshot)).resolves.toMatchObject({
      outcome: "REPLAY",
      digest: snapshot.digest,
    });
    expect(fixture.writeAttempts).toBe(2);
    expect(fixture.mutations).toBe(1);
  });

  it("rejects digest and membership drift before D1 mutation", async () => {
    const fixture = new D1AdmissionFixture();
    const authority = store(fixture);
    const snapshot = await scopeSnapshot();

    await expect(
      authority.admitScopeSnapshot({ ...snapshot, digest: "0".repeat(64) }),
    ).rejects.toEqual(expectedError("FEDERATION_REFERENCE_DIGEST_MISMATCH"));

    const invalidMembers = await scopeSnapshot({
      source_owner_generations: {},
    });
    await expect(
      authority.admitScopeSnapshot(invalidMembers),
    ).rejects.toEqual(expectedError("FEDERATION_SCOPE_MEMBERSHIP_MISMATCH"));
    expect(fixture.writeAttempts).toBe(0);
  });

  it("returns identity conflict instead of replacing an existing snapshot", async () => {
    const fixture = new D1AdmissionFixture();
    const authority = store(fixture);
    await authority.admitScopeSnapshot(await scopeSnapshot());
    const drift = await scopeSnapshot({ policy_authority_ref: "privacy-policy-2" });

    await expect(authority.admitScopeSnapshot(drift)).rejects.toEqual(
      expectedError("FEDERATION_REFERENCE_IDENTITY_CONFLICT"),
    );
    expect(fixture.mutations).toBe(1);
  });

  it("reconciles a lost snapshot acknowledgement without a second insert", async () => {
    const fixture = new D1AdmissionFixture();
    fixture.writeMode = "throw-after";
    const authority = store(fixture);

    await expect(
      authority.admitScopeSnapshot(await scopeSnapshot()),
    ).resolves.toMatchObject({ outcome: "RECONCILED" });
    expect(fixture.writeAttempts).toBe(1);
    expect(fixture.mutations).toBe(1);
  });

  it("does not retry an unresolved snapshot write", async () => {
    const fixture = new D1AdmissionFixture();
    fixture.writeMode = "throw-before";
    const authority = store(fixture);

    await expect(
      authority.admitScopeSnapshot(await scopeSnapshot()),
    ).rejects.toEqual(expect.objectContaining({
      code: "FEDERATION_REFERENCE_WRITE_UNCERTAIN",
      ambiguous_effect: "FEDERATION_REFERENCE_WRITE",
    }));
    expect(fixture.writeAttempts).toBe(1);
    expect(fixture.mutations).toBe(0);
  });

  it("requires the exact ScopeSnapshot before manifest admission", async () => {
    const fixture = new D1AdmissionFixture();
    const authority = store(fixture);

    await expect(
      authority.admitAllowedReferenceManifest(await manifest()),
    ).rejects.toEqual(expectedError("FEDERATION_SCOPE_SNAPSHOT_NOT_FOUND"));
    expect(fixture.writeAttempts).toBe(0);
  });

  it("creates and replays a manifest only under matching fence, expiry and members", async () => {
    const fixture = new D1AdmissionFixture();
    const authority = store(fixture);
    const snapshot = await scopeSnapshot();
    const admittedManifest = await manifest();
    await authority.admitScopeSnapshot(snapshot);

    await expect(
      authority.admitAllowedReferenceManifest(admittedManifest),
    ).resolves.toMatchObject({
      kind: "ALLOWED_REFERENCE_MANIFEST",
      outcome: "CREATED",
      digest: admittedManifest.manifest_digest,
    });
    await expect(
      authority.admitAllowedReferenceManifest(admittedManifest),
    ).resolves.toMatchObject({ outcome: "REPLAY" });
    expect(fixture.mutations).toBe(2);
  });

  it("rejects manifest binding drift before insert", async () => {
    const fixture = new D1AdmissionFixture();
    const authority = store(fixture);
    await authority.admitScopeSnapshot(await scopeSnapshot());
    const writesBefore = fixture.writeAttempts;

    await expect(
      authority.admitAllowedReferenceManifest(
        await manifest({ client_fence_ref: "other-client-fence" }),
      ),
    ).rejects.toEqual(expectedError("FEDERATION_REFERENCE_BINDING_MISMATCH"));

    await expect(
      authority.admitAllowedReferenceManifest(
        await manifest({ expires_at: "2026-09-06T14:00:00.000Z" }),
      ),
    ).rejects.toEqual(expectedError("FEDERATION_REFERENCE_BINDING_MISMATCH"));

    await expect(
      authority.admitAllowedReferenceManifest(
        await manifest({ allowed_source_revision_refs: [] }),
      ),
    ).rejects.toEqual(expectedError("FEDERATION_REFERENCE_BINDING_MISMATCH"));
    expect(fixture.writeAttempts).toBe(writesBefore);
  });

  it("returns conflict for different manifest bytes under one revision", async () => {
    const fixture = new D1AdmissionFixture();
    const authority = store(fixture);
    await authority.admitScopeSnapshot(await scopeSnapshot());
    await authority.admitAllowedReferenceManifest(await manifest());
    const drift = await manifest({
      allowed_use: ["federation.status"],
    });

    await expect(
      authority.admitAllowedReferenceManifest(drift),
    ).rejects.toEqual(expectedError("FEDERATION_REFERENCE_IDENTITY_CONFLICT"));
    expect(fixture.mutations).toBe(2);
  });

  it("reconciles a lost manifest acknowledgement without another insert", async () => {
    const fixture = new D1AdmissionFixture();
    const authority = store(fixture);
    await authority.admitScopeSnapshot(await scopeSnapshot());
    fixture.writeMode = "throw-after";

    await expect(
      authority.admitAllowedReferenceManifest(await manifest()),
    ).resolves.toMatchObject({ outcome: "RECONCILED" });
    expect(fixture.writeAttempts).toBe(2);
    expect(fixture.mutations).toBe(2);
  });

  it("does not retry an unresolved manifest write", async () => {
    const fixture = new D1AdmissionFixture();
    const authority = store(fixture);
    await authority.admitScopeSnapshot(await scopeSnapshot());
    fixture.writeMode = "throw-before";

    await expect(
      authority.admitAllowedReferenceManifest(await manifest()),
    ).rejects.toEqual(expect.objectContaining({
      code: "FEDERATION_REFERENCE_WRITE_UNCERTAIN",
      ambiguous_effect: "FEDERATION_REFERENCE_WRITE",
    }));
    expect(fixture.writeAttempts).toBe(2);
    expect(fixture.mutations).toBe(1);
  });

  it("rejects an invalid CORE_DB binding at composition time", () => {
    expect(() =>
      createD1FederationReferenceAuthorityStore({} as D1Database),
    ).toThrow(FederationD1ReferenceAdmissionError);
  });
});
