import type { ErasureFence } from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import { resetErasureAttempt } from "./authority-reset.js";

interface Call {
  readonly sql: string;
  readonly values: readonly unknown[];
}

function databaseFixture(): { readonly database: D1Database; readonly calls: Call[] } {
  const calls: Call[] = [];
  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          calls.push({ sql, values });
          return {
            async first<T>() {
              return { state: "REQUESTED", closure_digest: null } as T;
            },
            async run<T>() {
              return { success: true, results: [] } as unknown as D1Result<T>;
            },
          };
        },
      };
    },
    async batch<T>(statements: readonly D1PreparedStatement[]) {
      expect(statements).toHaveLength(5);
      return statements.map(() => ({ success: true, results: [] })) as unknown as D1Result<T>[];
    },
  } as unknown as D1Database;
  return { database, calls };
}

const fence: ErasureFence = {
  erasure_id: "erasure-1",
  revision: 1,
  lease_owner: "worker-2",
  lease_generation: 2,
  lease_until_ms: 20_000,
};

describe("erasure replay reset", () => {
  it("clears only transient closure state under the exact current lease generation", async () => {
    const fixture = databaseFixture();
    await resetErasureAttempt(fixture.database, fence, "2026-09-01T00:00:00.000Z");
    const sql = fixture.calls.map((call) => call.sql).join("\n");
    expect(sql).toContain("DELETE FROM backup_purge_obligation");
    expect(sql).toContain("DELETE FROM erasure_target");
    expect(sql).toContain("e.lease_owner=?3 AND e.lease_generation=?4");
    expect(sql).not.toContain("DELETE FROM purge_ledger");
    expect(fixture.calls.every((call) =>
      call.values[0] === "erasure-1" && call.values[1] === 1)).toBe(true);
  });
});
