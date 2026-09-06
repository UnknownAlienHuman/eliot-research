import { expect, it } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { readCatalog } from "./catalog-service.js";
const context: AuthenticatedRequestContext = { request: new Request("https://research.example/"),
  principal_ref: "owner", credential_generation: "credential-1", client_class: "owner_pwa", trace_id: "trace-1" };
const noDatabase = { prepare() { throw new Error("Database must not be accessed"); } } as unknown as D1Database;
it("rejects malformed identifiers, legacy cursors, invalid limits and service class before SQL", async () => {
  for (const request of [{ project_id: "../other", limit: 10 }, { limit: 0 }, { limit: 101 },
    { limit: 10, cursor: btoa(JSON.stringify({ version: 1, project_id: null, source_after: "", project_after: "" })) }]) {
    await expect(readCatalog(noDatabase, context, request, "deploy-1")).rejects.toMatchObject({ status: 400 });
  }
  await expect(readCatalog(noDatabase, { ...context, client_class: "trusted_agent" }, { limit: 10 }, "deploy-1"))
    .rejects.toMatchObject({ code: "CATALOG_OWNER_REQUIRED", status: 403 });
});
