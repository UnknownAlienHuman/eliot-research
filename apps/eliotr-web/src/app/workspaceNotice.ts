/** A deployment-reload notice takes precedence over later, less important notices. */
export function shouldPreserveStickyWorkspaceNotice(current: unknown): boolean {
  return typeof current === "object" && current !== null && "sticky" in current &&
    (current as { readonly sticky?: unknown }).sticky === true;
}
