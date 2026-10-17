import type { ProjectListView } from "@eliotr/owner-api-client";

/** Match the existing project readback bound; never walk an unbounded owner project list. */
export const LAST_PROJECT_LOOKUP_MAX_PAGES = 32;

export type LastProjectLookupResult =
  | { readonly state: "found"; readonly page: ProjectListView; readonly after_project_id?: string;
      readonly page_cursors: readonly (string | undefined)[] }
  | { readonly state: "absent" }
  | { readonly state: "incomplete" }
  | { readonly state: "stale" };

/** Find one saved ID only in current-owner pages, with cursors checked for strict forward progress. */
export async function findCurrentOwnerProjectPage(input: {
  readonly project_id: string;
  readonly deployment_generation: string;
  readonly first_page: ProjectListView;
  readonly read_page: (after_project_id: string) => Promise<ProjectListView>;
  readonly is_current: () => boolean;
}): Promise<LastProjectLookupResult> {
  let page = input.first_page;
  let afterProjectId: string | undefined;
  const pageCursors: (string | undefined)[] = [undefined];
  const visited = new Set<string>();

  for (let pageNumber = 0; pageNumber < LAST_PROJECT_LOOKUP_MAX_PAGES; pageNumber += 1) {
    const cursor = afterProjectId;
    if (!input.is_current() || page.deployment_generation !== input.deployment_generation ||
        (cursor !== undefined && page.projects.some(project => project.project_id <= cursor))) {
      return { state: "stale" };
    }
    if (page.projects.some(project => project.project_id === input.project_id)) {
      return { state: "found", page, page_cursors: pageCursors,
        ...(afterProjectId === undefined ? {} : { after_project_id: afterProjectId }) };
    }

    const next = page.next_project_id;
    if (next === undefined) return { state: "absent" };
    const last = page.projects.at(-1);
    if (last === undefined || next !== last.project_id ||
        (afterProjectId !== undefined && next <= afterProjectId) || visited.has(next)) {
      return { state: "stale" };
    }
    if (input.project_id <= next) return { state: "absent" };
    if (pageNumber + 1 === LAST_PROJECT_LOOKUP_MAX_PAGES) return { state: "incomplete" };
    visited.add(next);
    afterProjectId = next;
    pageCursors.push(next);
    if (!input.is_current()) return { state: "stale" };
    page = await input.read_page(next);
  }

  return { state: "incomplete" };
}
