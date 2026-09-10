import { describe, expect, it } from "vitest";
import { readCatalog } from "./catalog-service.js";

function database(rows: {
  readonly projects?: readonly Record<string, unknown>[];
  readonly sources?: readonly Record<string, unknown>[];
}): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async all<T>() {
              const selected = sql.includes("FROM project")
                ? rows.projects ?? []
                : rows.sources ?? [];
              return { success: true, results: [...selected] as T[] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("catalog authority decoding", () => {
  it("fails closed on malformed D1 authority rows", async () => {
    let error: unknown;
    try {
      await readCatalog(database({
        projects: [{ id: "project-a", title: "bad\u0000title", generation: 1 }],
      }), { limit: 10 });
    } catch (caught) {
      error = caught;
    }
    expect(error instanceof Error).toBe(true);
    expect((error as Error).message).toBe("catalog authority returned invalid project title");
  });

  it("rejects unsafe request identifiers before D1 execution", async () => {
    let error: unknown;
    try {
      await readCatalog(database({}), { project_id: "../other-project", limit: 10 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "CATALOG_IDENTIFIER_INVALID" });
  });
});
