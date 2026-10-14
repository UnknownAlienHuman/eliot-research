import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComputerAgentMutationNotice, type ComputerAgentMutationNoticeState } from "./ComputerAgentConnectionsPanel";

function render(state: ComputerAgentMutationNoticeState): string {
  return renderToStaticMarkup(createElement(ComputerAgentMutationNotice, {
    locale: "en",
    state,
    onReadback: () => undefined,
    onRetrySameAction: () => undefined,
  }));
}

describe("computer-agent mutation reconciliation notice", () => {
  it("keeps an unknown outcome visible for same-action reconciliation", () => {
    const markup = render({ kind: "unknown", readbackMatches: false, canRetrySameAction: true });
    expect(markup).toContain("outcome is unknown");
    expect(markup).toContain("Retry the same reviewed action");
    expect(markup).toContain("Read the protected configuration again");
  });

  it("hides protected connection details when the session is lost", () => {
    const markup = render({ kind: "session-lost" });
    expect(markup).toContain("owner session is no longer current");
    expect(markup).not.toContain("saved-agent-secret");
    expect(markup).not.toContain("computer-agent-change-");
  });

  it("shows committed receipt lag with a readback action and no mutation retry", () => {
    const markup = render({ kind: "receipt-pending-readback", revision: 8 });
    expect(markup).toContain("receipt for revision 8");
    expect(markup).toContain("Read the protected configuration again");
    expect(markup).not.toContain("Retry the same reviewed action");
  });

  it("renders the positive receipt plus protected-readback result", () => {
    const markup = render({ kind: "confirmed", revision: 8 });
    expect(markup).toContain("confirmed by receipt and protected readback at revision 8");
  });
});
