import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { decodeCatalogCursor, encodeCatalogCursor } from "@eliotr/cloudflare-navigation";

const sourceRead = vi.hoisted(() => vi.fn());
vi.mock("./source-content.js", () => ({ readProjectSourceContent: sourceRead }));

import { MCP_SOURCE_PAGE_MAX_BYTES, readMcpSourcePage } from "./mcp-source-reader.js";
import type { ProjectSourceContent } from "./source-content.js";

const ownerContext: AuthenticatedRequestContext = {
  request: new Request("https://mcp.example/mcp"),
  principal_ref: "alice@example.com",
  client_class: "owner_pwa",
  credential_generation: "access-generation-1",
  trace_id: "trace-1",
};
const env = {} as Env;

async function digest(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function document(text: string): Promise<ProjectSourceContent> {
  const bytes = new TextEncoder().encode(text);
  return {
    project_id: "project-a", source_id: "source-a", source_revision_ref: "revision-a",
    content_sha256: await digest(bytes), bytes, size_bytes: bytes.byteLength,
    context_sha256: "a".repeat(64), authority_generation: 7,
    observed_at: 1_800_000_000_000, expires_at: 1_800_000_300_000,
  };
}

describe("MCP exact source pagination", () => {
  beforeEach(() => sourceRead.mockReset());

  it("keeps multi-byte Unicode intact across bounded byte pages and verifies each page digest", async () => {
    const exact = "A💖B";
    sourceRead.mockResolvedValue(await document(exact));
    const first = await readMcpSourcePage(env, ownerContext, {
      project_id: "project-a", source_revision_ref: "revision-a", page_bytes: 1,
    });
    expect(first.text).toBe("A");
    expect(first.byte_range).toEqual({ start: 0, end: 1 });
    expect(first.page_sha256).toBe(await digest(new TextEncoder().encode("A")));
    expect(first.next_cursor).toBeDefined();

    const second = await readMcpSourcePage(env, ownerContext, {
      project_id: "project-a", source_revision_ref: "revision-a", page_bytes: 1,
      cursor: String(first.next_cursor),
    });
    expect(second.text).toBe("💖");
    expect(second.byte_range).toEqual({ start: 1, end: 5 });

    const third = await readMcpSourcePage(env, ownerContext, {
      project_id: "project-a", source_revision_ref: "revision-a", page_bytes: 1,
      cursor: String(second.next_cursor),
    });
    expect(third.text).toBe("B");
    expect(third.byte_range).toEqual({ start: 5, end: 6 });
    expect(third.next_cursor).toBeUndefined();
    expect(first.source_revision_ref).toBe("revision-a");
    expect(first.content_sha256).toBe(await digest(new TextEncoder().encode(exact)));
  });

  it("binds cursors to exact project, revision, content, owner context and authority generation", async () => {
    const exact = await document("one two");
    sourceRead.mockImplementation(async (_env: unknown, context: AuthenticatedRequestContext) => ({
      ...exact,
      context_sha256: context.principal_ref === "alice@example.com" ? "a".repeat(64) : "b".repeat(64),
    }));
    const first = await readMcpSourcePage(env, ownerContext, {
      project_id: "project-a", source_revision_ref: "revision-a", page_bytes: 3,
    });
    const raw = decodeCatalogCursor(String(first.next_cursor)) as Record<string, unknown>;
    const tampered = encodeCatalogCursor({ ...raw, project_id: "project-b" });
    await expect(readMcpSourcePage(env, ownerContext, {
      project_id: "project-a", source_revision_ref: "revision-a", page_bytes: 3, cursor: tampered,
    })).rejects.toMatchObject({ code: "SOURCE_READ_CURSOR_STALE" });
    await expect(readMcpSourcePage(env, ownerContext, {
      project_id: "project-a", source_revision_ref: "revision-b", page_bytes: 3, cursor: String(first.next_cursor),
    })).rejects.toMatchObject({ code: "SOURCE_READ_CURSOR_STALE" });
    sourceRead.mockResolvedValue({ ...exact, authority_generation: 8 });
    await expect(readMcpSourcePage(env, ownerContext, {
      project_id: "project-a", source_revision_ref: "revision-a", page_bytes: 3, cursor: String(first.next_cursor),
    })).rejects.toMatchObject({ code: "SOURCE_READ_CURSOR_STALE" });
    sourceRead.mockImplementation(async (_env: unknown, context: AuthenticatedRequestContext) => ({
      ...exact,
      context_sha256: context.principal_ref === "alice@example.com" ? "a".repeat(64) : "b".repeat(64),
    }));
    await expect(readMcpSourcePage(env, { ...ownerContext, principal_ref: "bob@example.com" }, {
      project_id: "project-a", source_revision_ref: "revision-a", page_bytes: 3, cursor: String(first.next_cursor),
    })).rejects.toMatchObject({ code: "SOURCE_READ_CURSOR_STALE" });
    sourceRead.mockResolvedValue(await document("changed content"));
    await expect(readMcpSourcePage(env, ownerContext, {
      project_id: "project-a", source_revision_ref: "revision-a", page_bytes: 3, cursor: String(first.next_cursor),
    })).rejects.toMatchObject({ code: "SOURCE_READ_CURSOR_STALE" });
  });

  it("rejects malformed cursors and oversized pages without reading source storage", async () => {
    await expect(readMcpSourcePage(env, ownerContext, {
      project_id: "project-a", source_revision_ref: "revision-a", cursor: "not-a-canonical-cursor",
    })).rejects.toMatchObject({ code: "SOURCE_READ_CURSOR_INVALID" });
    await expect(readMcpSourcePage(env, ownerContext, {
      project_id: "project-a", source_revision_ref: "revision-a", page_bytes: MCP_SOURCE_PAGE_MAX_BYTES + 1,
    })).rejects.toMatchObject({ code: "SOURCE_READ_PAGE_LIMIT_INVALID" });
    expect(sourceRead).not.toHaveBeenCalled();
  });
});
