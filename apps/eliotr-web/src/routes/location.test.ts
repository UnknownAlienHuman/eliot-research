import { describe, expect, it } from "vitest";
import { canonicalWorkspacePath, decodeWorkspaceLocation, destinations, workspacePath } from "./location";
describe("public destination URLs", () => {
  it("round trips only the four fixed destinations", () => {
    for (const item of destinations) expect(decodeWorkspaceLocation({ pathname: workspacePath(item), search: "", hash: "" })).toBe(item);
  });
  it("removes queries, protected IDs, fragments and encoded paths instead of preserving them", () => {
    for (const path of ["/sources/private-id", "/%72esearch", "//foreign", "/studio/"]) expect(canonicalWorkspacePath({ pathname: path, search: "", hash: "" })).toBe("/research");
    expect(decodeWorkspaceLocation({ pathname: "/sources", search: "?grant=secret", hash: "" })).toBeUndefined();
    expect(canonicalWorkspacePath({ pathname: "/studio", search: "", hash: "#private-text" })).toBe("/research");
    expect(() => workspacePath("foreign" as typeof destinations[number])).toThrow(TypeError);
  });
});
