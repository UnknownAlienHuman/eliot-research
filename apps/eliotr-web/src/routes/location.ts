export const destinations = ["sources", "research", "studio", "connections"] as const;
export type Destination = typeof destinations[number];
export function workspacePath(destination: Destination): string {
  if (!destinations.includes(destination)) throw new TypeError("Unknown workspace destination");
  return `/${destination}`;
}
export function decodeWorkspaceLocation(location: { readonly pathname: string; readonly search: string; readonly hash: string }): Destination | undefined {
  if (location.search !== "" || location.hash !== "") return undefined;
  if (location.pathname === "/") return "research";
  return destinations.find(destination => workspacePath(destination) === location.pathname);
}
export function canonicalWorkspacePath(location: { readonly pathname: string; readonly search: string; readonly hash: string }): string {
  return workspacePath(decodeWorkspaceLocation(location) ?? "research");
}
