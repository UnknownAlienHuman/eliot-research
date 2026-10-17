import { describe, expect, it } from "vitest";
import { shouldPreserveStickyWorkspaceNotice } from "./workspaceNotice";

describe("sticky workspace notices", () => {
  it("keeps the reload action when a later import notice arrives", () => {
    const reload = { sticky: true, message: "Eliot was updated", action: "Reload" };

    expect(shouldPreserveStickyWorkspaceNotice(reload)).toBe(true);
  });

  it("allows ordinary notices to replace or initialize a notice", () => {
    expect(shouldPreserveStickyWorkspaceNotice({ sticky: false, message: "Sources failed" })).toBe(false);
    expect(shouldPreserveStickyWorkspaceNotice(undefined)).toBe(false);
  });
});
