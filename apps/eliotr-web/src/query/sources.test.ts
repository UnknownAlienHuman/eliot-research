import { describe, expect, it, vi } from "vitest";
import { createProjectsApi, createLibraryApi, createReadinessApi, createRevisionApi } from "@eliotr/owner-api-client";
import type { LegacyErrorFactory, ProjectListView, LibraryPage } from "@eliotr/owner-api-client";
import { createPrivacyController } from "../app/privacy";
import { createWorkspaceQueryClient } from "./client";
import { sourcesQueryOptions } from "./sources";

async function fixture() {
  const privacy = createPrivacyController({
    now: () => Date.parse("2026-10-09T00:00:00.000Z"),
    timers: { setTimeout: () => 0, clearTimeout() {} },
    mask() {}, reveal() {}, cancelReads() {}, clearProtected() {},
    async verify() { return { principal: "owner", credentialGeneration: "credentials", deploymentGeneration: "deployment", expiresAt: "2027-01-01T00:00:00.000Z" }; },
  });
  await privacy.refresh();
  const snapshot = privacy.getSnapshot();
  if (snapshot.phase !== "available") throw new Error("Fixture unavailable");
  const request = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(async () => undefined);
  const http = { requestApi: request, requestApiWithStatuses: request };
  const epoch = { capture: () => snapshot.context, isCurrent: (value: unknown) => value === snapshot.context };
  const errors: LegacyErrorFactory = details => Object.assign(new Error(details.message), details);
  const apis = {
    projects: createProjectsApi(http, errors, epoch), library: createLibraryApi(http, errors, epoch),
    readiness: createReadinessApi(http, errors, epoch), revisions: createRevisionApi(http, errors, epoch),
  };
  const current = { projects, page };
  return { options: sourcesQueryOptions(apis, privacy, snapshot.context, { projects: () => current.projects, library: () => current.page }), current, request, client: createWorkspaceQueryClient() };
}

const projects: ProjectListView = {
  protocol: "eliotr.project-owner-list.v1", deployment_generation: "deployment",
  projects: [{ project_id: "current-project", title: "Current", revision: 1, source_ids: [], created_at: "2026-10-09T00:00:00.000Z" }],
};
const page: LibraryPage = { projects: [], sources: [{ id: "current-source", title: "Current source", readiness_ref: "readiness-ref" }], generation: "deployment", trace: "trace" };

describe("Sources Query current scope", () => {
  it("rejects a library result when the current project page changes during the request", async () => {
    const test = await fixture();
    test.request.mockImplementationOnce(async () => {
      test.current.projects = { ...projects, projects: [] };
      return { data: { projects: [], sources: [] }, deployment_generation: "deployment", trace_id: "trace" };
    });
    await expect(test.client.fetchQuery(test.options.library(projects, "current-project"))).rejects.toThrow("Selected project");
    expect(test.client.getQueryData(test.options.library(projects, "current-project").queryKey)).toBeUndefined();
    test.client.clear();
  });
  it("rejects a foreign project before making a transport request", async () => {
    const test = await fixture();
    await expect(test.client.fetchQuery(test.options.library(projects, "foreign-project"))).rejects.toThrow("Selected project");
    expect(test.request).not.toHaveBeenCalled();
    test.client.clear();
  });
  it("rejects a foreign source before readiness or revision reads", async () => {
    const test = await fixture();
    await expect(test.client.fetchQuery(test.options.readiness(page, "foreign-source"))).rejects.toThrow("Selected source");
    await expect(test.client.fetchQuery(test.options.revisions(page, "foreign-source"))).rejects.toThrow("Selected source");
    expect(test.request).not.toHaveBeenCalled();
    test.client.clear();
  });
  it("rejects an old library generation before reading the current source", async () => {
    const test = await fixture();
    await expect(test.client.fetchQuery(test.options.readiness({ ...page, generation: "old-deployment" }, "current-source"))).rejects.toThrow("Selected source");
    expect(test.request).not.toHaveBeenCalled();
    test.client.clear();
  });
  it("rejects a replaced caller-held project or library page even in the same generation", async () => {
    const test = await fixture();
    test.current.projects = { ...projects, projects: [] };
    test.current.page = { ...page, sources: [] };
    await expect(test.client.fetchQuery(test.options.library(projects, "current-project"))).rejects.toThrow("Selected project");
    await expect(test.client.fetchQuery(test.options.readiness(page, "current-source"))).rejects.toThrow("Selected source");
    expect(test.request).not.toHaveBeenCalled();
    test.client.clear();
  });
});
