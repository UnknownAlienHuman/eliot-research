import { afterEach, expect, test, vi } from "vitest";
import { env } from "cloudflare:workers";
import { readOwnerResearchRuns } from "../src/research-run-list.js";
import { handleHttp } from "../src/http.js";
import { fixture, originalReport, runtime } from "./artifact-cow-http-fixture.js";
import { principal } from "./research-evidence-freeze-fixture.js";

const binding = (env as unknown as { OWNER_ARTIFACT_FIXTURE?: string }).OWNER_ARTIFACT_FIXTURE;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test.skipIf(binding === undefined)("exports an actual owner artifact and original run for the persistent browser harness", async () => {
  const configuration = JSON.parse(binding ?? "{}") as { collector_url: string; profile?: "accepted-child" | "original-report" };
  const url = new URL(configuration.collector_url);
  expect(url.protocol).toBe("http:"); expect(url.hostname).toBe("127.0.0.1");
  const profile = configuration.profile ?? "accepted-child";
  expect(["accepted-child", "original-report"]).toContain(profile);
  // Original REPORT retains its actual completed W2 and current execution policy.
  // The COW fixture separately retires that policy to exercise historical renewal.
  const original = profile === "original-report" ? await originalReport("observation", true) : undefined;
  const child = original === undefined ? await fixture("observation", true) : undefined;
  const data = original ?? child;
  if (data === undefined) throw new Error("Native profile is missing");
  const configuredEnv = child?.configuredEnv ?? { ...runtime, DEPLOYMENT_GENERATION: principal.deployment_generation };
  const http = (path: string, method = "GET", body?: unknown) => handleHttp(new Request("https://research.example" + path, { method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json", "idempotency-key": "owner-browser-fixture-accept" }, body: JSON.stringify(body) }) }),
  configuredEnv, {} as ExecutionContext, { accessVerifier: { verify: async () => ({
    principal_ref: principal.principal_ref, credential_generation: principal.credential_generation,
    authentication_method: "cloudflare_access", expires_at: new Date(Date.now() + 3_600_000).toISOString() }) } });
  let artifact = data.artifact_ref;
  let publication: { revision: { status: string; sections: { section_ref: { id: string; revision: number }; body_sha256: string }[] }; receipt: { publication_ref: string } } | undefined;
  if (child !== undefined) {
    const revised = await child.post(configuredEnv, "owner-browser-fixture-revise");
    expect(revised.status).toBe(201);
    const ref = revised.body.data?.draft?.artifact_ref;
    if (ref === undefined) throw new Error("Actual native child was not committed");
    artifact = ref;
    const response = await http("/api/v1/research/artifact/" + encodeURIComponent(artifact.id + ":" + artifact.revision) + "/accept", "POST",
      { protocol: "eliotr.artifact-publication-accept.v1", expected_draft_head_revision: artifact.revision, expected_publication_revision: null });
    expect(response.status).toBe(201);
    publication = (await response.json() as { data: NonNullable<typeof publication> }).data;
    expect(publication.revision.status).toBe("ACCEPTED"); expect(child.modelCalls()).toBe(2);
    await child.originalsUnchanged();
  }
  const history = await readOwnerResearchRuns(configuredEnv, data.context);
  expect(history.saved_drafts.some((draft) => draft.artifact_ref.id === artifact.id && draft.artifact_ref.revision === artifact.revision)).toBe(true);
  let runStatus: unknown;
  if (original !== undefined) {
    expect(artifact.revision).toBe(1); expect(original.original_model_calls).toBe(2);
    const response = await http("/api/v1/research/run/" + encodeURIComponent(data.freeze.operation_id));
    expect(response.status).toBe(200);
    const status = (await response.json() as { data: { workflow_instance_id: string; execution_state: string; next_stage_index: number;
      answer: { availability: string; artifact_ref: { id: string; revision: number } } } }).data;
    expect(status.workflow_instance_id).toBe(data.freeze.operation_id);
    expect(status.execution_state).toBe("ENGINE_COMPLETED"); expect(status.next_stage_index).toBe(18);
    expect(status.answer).toEqual({ availability: "draft", artifact_ref: artifact });
    expect(history.runs.filter(({ status: entry }) => entry.workflow_instance_id === data.freeze.operation_id)).toHaveLength(1);
    expect(history.saved_drafts.find((draft) => draft.artifact_ref.id === artifact.id && draft.artifact_ref.revision === artifact.revision)?.workflow_instance_id).toBe(data.freeze.operation_id);
    runStatus = status;
  }
  const section = publication?.revision.sections[0] ?? data.snapshot.sections[0]?.section;
  if (section === undefined) throw new Error("Native section is missing");
  const sectionResponse = await http("/api/v1/research/artifact/" + encodeURIComponent(artifact.id + ":" + artifact.revision) + "/sections/" +
    encodeURIComponent(section.section_ref.id + ":" + section.section_ref.revision) + "/reauthorize", "POST");
  expect(sectionResponse.status).toBe(200);
  const section_text = new TextDecoder("utf-8", { fatal: true }).decode(await sectionResponse.arrayBuffer());
  const readPolicies = await runtime.CORE_DB.prepare("SELECT source_namespace_id,principal_ref,client_class,policy_ref,generation FROM scope_read_policy WHERE principal_ref=?1 AND state='ACTIVE'")
    .bind(principal.principal_ref).all();
  const run = await runtime.CORE_DB.prepare("SELECT operation_id FROM research_workflow_run WHERE operation_id=?1")
    .bind(data.freeze.operation_id).first();
  expect(run).not.toBeNull();
  const result = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocol: "eliotr.owner-artifact-native-snapshot.v1", profile, artifact, publication,
      principal, run: { ...run, ...(runStatus === undefined ? {} : { status: runStatus }) }, section, section_text,
      read_policy_keys: readPolicies.results, source_revision_refs: data.freeze.scope.member_source_revision_refs,
      model_calls: child?.modelCalls() ?? original?.original_model_calls,
      native_buckets: { EVIDENCE_BUCKET: "eliotr-evidence-test", WORK_BUCKET: "eliotr-work-test" },
      native_databases: { CORE_DB: "eliotr-core-test", SEARCH_DB: "eliotr-search-test" } }) });
  expect(result.status).toBe(200); expect(await result.text()).toBe("SNAPSHOT_SAVED");
}, 170_000);
