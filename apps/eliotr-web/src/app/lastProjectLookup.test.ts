import { describe, expect, it, vi } from "vitest";
import type { ProjectListView, ProjectSummary } from "@eliotr/owner-api-client";
import { findCurrentOwnerProjectPage, LAST_PROJECT_LOOKUP_MAX_PAGES } from "./lastProjectLookup";

const generation = "deployment-current";
const project = (project_id: string): ProjectSummary => ({ project_id, title: project_id,
  revision: 1, source_ids: [], created_at: "2026-10-17T00:00:00.000Z" });
const page = (ids: readonly string[], next?: string): ProjectListView => ({
  protocol: "eliotr.project-owner-list.v1", deployment_generation: generation,
  projects: ids.map(project), ...(next === undefined ? {} : { next_project_id: next }),
});

describe("current-owner last-project lookup", () => {
  it("finds a project on a later page and returns the exact page cursor", async () => {
    const readPage = vi.fn(async (after: string) => {
      expect(after).toBe("project-a");
      return page(["project-z"]);
    });

    const result = await findCurrentOwnerProjectPage({ project_id: "project-z", deployment_generation: generation,
      first_page: page(["project-a"], "project-a"), read_page: readPage, is_current: () => true });

    expect(result).toEqual({ state: "found", page: page(["project-z"]), after_project_id: "project-a",
      page_cursors: [undefined, "project-a"] });
    expect(readPage).toHaveBeenCalledOnce();
  });

  it("calls a project absent only after the ordered current-owner list passes it", async () => {
    const readPage = vi.fn(async () => page(["project-z"]));

    const result = await findCurrentOwnerProjectPage({ project_id: "project-m", deployment_generation: generation,
      first_page: page(["project-a"], "project-a"), read_page: readPage, is_current: () => true });

    expect(result).toEqual({ state: "absent" });
    expect(readPage).toHaveBeenCalledOnce();
  });

  it("leaves membership unknown when the bounded page scan is exhausted", async () => {
    const readPage = vi.fn(async (after: string) => page([`project-${String(Number(after.slice(-3)) + 1).padStart(3, "0")}`],
      `project-${String(Number(after.slice(-3)) + 1).padStart(3, "0")}`));
    const result = await findCurrentOwnerProjectPage({ project_id: "zz-last", deployment_generation: generation,
      first_page: page(["project-000"], "project-000"), read_page: readPage, is_current: () => true });

    expect(result).toEqual({ state: "incomplete" });
    expect(readPage).toHaveBeenCalledTimes(LAST_PROJECT_LOOKUP_MAX_PAGES - 1);
  });

  it("stops without treating a changed generation as absence", async () => {
    const readPage = vi.fn(async () => page(["project-z"]));
    const result = await findCurrentOwnerProjectPage({ project_id: "project-z", deployment_generation: "old-deployment",
      first_page: page(["project-a"], "project-a"), read_page: readPage, is_current: () => true });

    expect(result).toEqual({ state: "stale" });
    expect(readPage).not.toHaveBeenCalled();
  });

  it("rejects a page when owner currentness changes during the lookup", async () => {
    let current = true;
    const readPage = vi.fn(async () => { current = false; return page(["project-z"]); });
    const result = await findCurrentOwnerProjectPage({ project_id: "project-z", deployment_generation: generation,
      first_page: page(["project-a"], "project-a"), read_page: readPage, is_current: () => current });

    expect(result).toEqual({ state: "stale" });
    expect(readPage).toHaveBeenCalledOnce();
  });
});
