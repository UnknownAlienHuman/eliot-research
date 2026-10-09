export type FocusCapture = {
  /**
   * Element that owned focus before a modal opened. A ref, not state, so a
   * re-render never loses the identity of the node that must receive focus back.
   */
  readonly node: HTMLElement | null;
};

/**
 * Remember the currently focused element. Returns null on the server and when
 * nothing focusable owns focus, so callers never have to null-check
 * document.activeElement themselves.
 */
export function captureFocus(): FocusCapture {
  if (typeof document === "undefined") return { node: null };
  const active = document.activeElement;
  return { node: active instanceof HTMLElement ? active : null };
}

/**
 * Return focus to the captured element when it is still attached to the
 * document. A detached opener must not receive focus, and a live opener must
 * not be silently skipped, so both cases are resolved explicitly.
 */
export function restoreFocus(capture: FocusCapture): void {
  const node = capture.node;
  if (node === null) return;
  if (typeof document === "undefined") return;
  if (!node.isConnected) return;
  node.focus();
}

