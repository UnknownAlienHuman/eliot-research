import { describe, expect, it } from "vitest";
import * as z from "zod";

import * as contracts from "./index.js";

interface AuditRow {
  readonly name: string;
  readonly json_schema: "ok" | "error";
  readonly root_type?: unknown;
  readonly additional_properties?: unknown;
  readonly error?: string;
}

describe("ER-01 exported schema inventory", () => {
  it("reports every exported Zod schema and JSON Schema conversion result", () => {
    const rows: AuditRow[] = [];

    for (const [name, value] of Object.entries(contracts).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!(value instanceof z.ZodType)) continue;

      try {
        const jsonSchema = z.toJSONSchema(value, {
          cycles: "ref",
          io: "input",
          reused: "ref",
          unrepresentable: "any",
        });
        rows.push({
          name,
          json_schema: "ok",
          root_type: jsonSchema.type,
          additional_properties: jsonSchema.additionalProperties,
        });
      } catch (error) {
        rows.push({
          name,
          json_schema: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    console.warn(`ER01_SCHEMA_AUDIT=${JSON.stringify(rows)}`);
    expect(rows.length).toBeGreaterThan(0);
  });
});
