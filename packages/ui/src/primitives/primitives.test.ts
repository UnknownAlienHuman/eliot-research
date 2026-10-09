import { afterEach, describe, expect, it, vi } from "vitest";
import { captureFocus, restoreFocus } from "./focus";

afterEach(() => vi.unstubAllGlobals());
describe("native modal focus ownership", () => {
  it("is safe when imported without a DOM", () => {
    expect(captureFocus()).toEqual({ node: null });
    expect(() => restoreFocus({ node: null })).not.toThrow();
  });
  it("returns to the connected opener but never focuses a detached old opener", () => {
    class Focusable {
      isConnected = true;
      focus = vi.fn();
    }
    const opener = new Focusable();
    vi.stubGlobal("HTMLElement", Focusable);
    vi.stubGlobal("document", { activeElement: opener });
    const captured = captureFocus();
    vi.stubGlobal("document", { activeElement: new Focusable() });
    restoreFocus(captured);
    expect(opener.focus).toHaveBeenCalledTimes(1);
    opener.isConnected = false;
    restoreFocus(captured);
    expect(opener.focus).toHaveBeenCalledTimes(1);
  });
});
