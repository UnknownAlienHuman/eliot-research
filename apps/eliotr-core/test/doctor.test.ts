import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runScheduledDoctor } from "../src/doctor.js";
import type { Env } from "../src/env.js";
import { db, runtime, setupOrientationDatabase } from "./orientation-fixture.js";

const CREATED_AT = "2026-10-15T12:00:00.000Z";
const cleanupIncidentIds = new Set<string>();

function fakeAI(answer: string) {
  return {
    run: vi.fn(async (_model: unknown, _input: unknown, _options: unknown) => ({ response: answer })),
  };
}

function doctorEnv(values: Partial<Env>): Env {
  return { ...runtime, ...values } as unknown as Env;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function doctorIncidentId(code: string, severity: string, componentRef: string): Promise<string> {
  return `doctor-health-${await sha256Hex(`${code}\u0000${severity}\u0000${componentRef}`)}`;
}

function fakeFetch(handler: (url: URL, init: RequestInit) => Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    return handler(url, init ?? {});
  }) as typeof fetch;
}

describe("scheduled native doctor", () => {
  beforeAll(async () => {
    await setupOrientationDatabase();
  });

  afterAll(async () => {
    for (const incidentId of cleanupIncidentIds) {
      await db.prepare("DELETE FROM doctor_delivery_outbox WHERE incident_id=?1").bind(incidentId).run();
      await db.prepare("DELETE FROM incident WHERE incident_id=?1").bind(incidentId).run();
    }
    await db.prepare("DELETE FROM incident WHERE incident_id LIKE 'doctor-test-%'").run();
  });

  it("persists an unconfigured sink as degraded, diagnoses once from codes, and deduplicates repeats", async () => {
    cleanupIncidentIds.add(await doctorIncidentId("OPTIONAL_CONNECTOR_DEGRADED", "WARNING", "github_issue_sink"));
    const ai = fakeAI("GitHub sink is unconfigured; health remains visible in D1.");
    const noNetwork = vi.fn(fakeFetch(async () => { throw new Error("unexpected fetch"); }));
    const env = doctorEnv({
      AI: ai as unknown as Env["AI"],
      ELIOTR_DOCTOR_GITHUB_REPOSITORY: "owner/repo",
      ELIOTR_DOCTOR_GITHUB_TOKEN: undefined,
      ELIOTR_MODEL_GATEWAY_TOKEN: undefined,
    });

    const first = await runScheduledDoctor(env, { fetch: noNetwork, now: () => Date.parse(CREATED_AT) });
    const snapshotRow = await db.prepare(
      "SELECT snapshot_json FROM health_snapshot WHERE snapshot_id='doctor-current'",
    ).first<{ readonly snapshot_json: string }>();
    const snapshot = JSON.parse(snapshotRow?.snapshot_json ?? "null") as {
      readonly status: string;
      readonly connector_states: Readonly<Record<string, string>>;
    };
    expect(first.health_status).toBe("DEGRADED");
    expect(first.github_sink).toBe("UNCONFIGURED");
    expect(snapshot.status).toBe("DEGRADED");
    expect(snapshot.connector_states.github_issue_sink).toBe("UNCONFIGURED");
    expect(noNetwork).not.toHaveBeenCalled();
    expect(ai.run).toHaveBeenCalledOnce();
    expect(env.ELIOTR_MODEL_GATEWAY_TOKEN).toBeUndefined();

    const request = ai.run.mock.calls[0]?.[1] as { readonly messages: readonly { readonly content: string }[] };
    expect(request.messages[1]?.content).toBe(JSON.stringify({ health_codes: ["OPTIONAL_CONNECTOR_DEGRADED"] }));
    expect(JSON.stringify(request.messages)).not.toMatch(/Users|private|secret|token|prompt_body/iu);

    const second = await runScheduledDoctor(env, { fetch: noNetwork, now: () => Date.parse(CREATED_AT) + 60_000 });
    expect(second.health_status).toBe("DEGRADED");
    expect(second.diagnosis_attempted).toBe(false);
    expect(ai.run).toHaveBeenCalledOnce();
    const outboxCount = await db.prepare(
      "SELECT COUNT(*) AS count FROM doctor_delivery_outbox d JOIN incident i ON i.incident_id=d.incident_id " +
      "WHERE i.kind='DOCTOR_HEALTH_OPTIONAL_CONNECTOR_DEGRADED' AND d.sink_ref='github-issue'",
    ).first<{ readonly count: number }>();
    expect(outboxCount?.count).toBe(1);
  });

  it("reconciles a timed-out issue through readback without another create", async () => {
    const sourceIncidentId = `doctor-test-${crypto.randomUUID()}`;
    const externalComponentRef = `incident-${(await sha256Hex(sourceIncidentId)).slice(0, 32)}`;
    cleanupIncidentIds.add(await doctorIncidentId("OPEN_INCIDENT", "ALERT", externalComponentRef));
    cleanupIncidentIds.add(await doctorIncidentId("OPTIONAL_CONNECTOR_DEGRADED", "WARNING", "github_issue_sink"));
    await db.prepare(
      "INSERT INTO incident(incident_id,severity,kind,state,details_ref,created_at,resolved_at) " +
      "VALUES(?1,'WARNING','operator-seed','OPEN',?2,?3,NULL)",
    ).bind(sourceIncidentId, "C:\\Users\\private\\credential-marker", CREATED_AT).run();

    const ai = fakeAI("Do not expose C:\\Users\\private\\secret or Bearer ghp_DOCTOR_TEST_SECRET.");
    const sequence: string[] = [];
    let postCount = 0;
    let issueMarker: string | null = null;
    let issueVisible = false;
    const fetchImpl = fakeFetch(async (url, init) => {
      const method = init.method ?? "GET";
      sequence.push(`${method} ${url.pathname}${url.search}`);
      if (url.pathname === "/repos/owner/repo" && method === "GET") {
        return Response.json({ full_name: "owner/repo" });
      }
      if (url.pathname === "/repos/owner/repo/issues" && method === "GET") {
        if (issueVisible && issueMarker !== null) {
          return Response.json([{ number: 991, title: "ELIOT health alert", body: `Marker: ${issueMarker}` }]);
        }
        return Response.json([]);
      }
      if (url.pathname === "/repos/owner/repo/issues" && method === "POST") {
        postCount += 1;
        const body = typeof init.body === "string" ? init.body : "";
        expect(body).not.toMatch(/Users|private|credential-marker|DOCTOR_TEST_SECRET|Bearer/iu);
        const markerMatch = /\[eliotr-doctor:[a-f0-9]{64}\]/u.exec(body);
        issueMarker = markerMatch?.[0] ?? null;
        if (postCount === 1) throw new TypeError("ambiguous network timeout");
        return Response.json({ number: 991 }, { status: 201 });
      }
      return new Response(null, { status: 404 });
    });
    const env = doctorEnv({
      AI: ai as unknown as Env["AI"],
      ELIOTR_DOCTOR_GITHUB_REPOSITORY: "owner/repo",
      ELIOTR_DOCTOR_GITHUB_TOKEN: "ghp_DOCTOR_TEST_SECRET",
      ELIOTR_MODEL_GATEWAY_TOKEN: undefined,
    });

    const first = await runScheduledDoctor(env, { fetch: fetchImpl, now: () => Date.parse(CREATED_AT) + 120_000 });
    const uncertain = await db.prepare(
      "SELECT d.state,d.last_error_code,d.diagnosis_state FROM doctor_delivery_outbox d " +
      "JOIN incident i ON i.incident_id=d.incident_id WHERE i.kind='DOCTOR_HEALTH_OPEN_INCIDENT' " +
      "AND i.details_ref LIKE 'health-code:OPEN_INCIDENT:%' LIMIT 1",
    ).first<{ readonly state: string; readonly last_error_code: string; readonly diagnosis_state: string }>();
    expect(first.github_sink).toBe("UNAVAILABLE");
    expect(postCount).toBe(1);
    expect(uncertain).toMatchObject({ state: "UNKNOWN", last_error_code: "GITHUB_CREATE_OUTCOME_UNKNOWN" });

    const secondStart = sequence.length;
    const second = await runScheduledDoctor(env, { fetch: fetchImpl, now: () => Date.parse(CREATED_AT) + 180_000 });
    const secondSequence = sequence.slice(secondStart);
    const readbackIndex = secondSequence.findIndex((entry) => entry.startsWith("GET /repos/owner/repo/issues?"));
    const secondPostIndex = secondSequence.findIndex((entry) => entry.startsWith("POST /repos/owner/repo/issues"));
    expect(second.github_sink).toBe("UNAVAILABLE");
    expect(postCount).toBe(1);
    expect(readbackIndex).toBeGreaterThanOrEqual(0);
    expect(secondPostIndex).toBe(-1);
    const stillUnknown = await db.prepare(
      "SELECT d.state,d.last_error_code FROM doctor_delivery_outbox d " +
      "JOIN incident i ON i.incident_id=d.incident_id WHERE i.kind='DOCTOR_HEALTH_OPEN_INCIDENT' " +
      "AND i.details_ref LIKE 'health-code:OPEN_INCIDENT:%' LIMIT 1",
    ).first<{ readonly state: string; readonly last_error_code: string }>();
    expect(stillUnknown).toEqual({ state: "UNKNOWN", last_error_code: "GITHUB_MARKER_ABSENT_AFTER_UNKNOWN" });

    issueVisible = true;
    const thirdStart = sequence.length;
    const third = await runScheduledDoctor(env, { fetch: fetchImpl, now: () => Date.parse(CREATED_AT) + 240_000 });
    const thirdSequence = sequence.slice(thirdStart);
    expect(third.github_sink).toBe("READY");
    expect(postCount).toBe(1);
    expect(thirdSequence.some((entry) => entry.startsWith("GET /repos/owner/repo/issues?"))).toBe(true);
    expect(thirdSequence.some((entry) => entry.startsWith("POST /repos/owner/repo/issues"))).toBe(false);
    expect(ai.run).toHaveBeenCalled();
    expect(env.ELIOTR_MODEL_GATEWAY_TOKEN).toBeUndefined();

    const delivered = await db.prepare(
      "SELECT d.state,d.external_issue_number,d.external_issue_url FROM doctor_delivery_outbox d " +
      "JOIN incident i ON i.incident_id=d.incident_id WHERE i.kind='DOCTOR_HEALTH_OPEN_INCIDENT' " +
      "AND d.state='DELIVERED' LIMIT 1",
    ).first<{ readonly state: string; readonly external_issue_number: number; readonly external_issue_url: string }>();
    expect(delivered).toEqual({
      state: "DELIVERED",
      external_issue_number: 991,
      external_issue_url: "https://github.com/owner/repo/issues/991",
    });
    expect(JSON.stringify(ai.run.mock.calls.map((call) => call[1]))).not.toMatch(/Users|private|credential-marker|DOCTOR_TEST_SECRET|Bearer/iu);

    await db.prepare("DELETE FROM incident WHERE incident_id=?1").bind(sourceIncidentId).run();
  });
});
