import { StrictMode, useEffect, useState } from "react";
import { MemoryRouter } from "react-router";
import { Shell } from "./Shell";
import { createPrivacyController } from "./privacy";

function ShellPreview() {
  const [privacy] = useState(() => createPrivacyController({
    mask() {}, reveal() {}, cancelReads() {}, clearProtected() {},
    async verify() { return { principal: "synthetic-owner", session: "synthetic-session", credentialGeneration: "fixture-only", deploymentGeneration: "fixture-only" }; },
  }));
  useEffect(() => { void privacy.refresh(); }, [privacy]);
  return <StrictMode><MemoryRouter initialEntries={["/research"]}><Shell privacy={privacy} fixture /></MemoryRouter></StrictMode>;
}
export default { title: "Workspace/Shell", component: ShellPreview, parameters: { layout: "fullscreen" } };
export const StrictModeJourney = {
  async play({ canvas }: { readonly canvas: { getByRole(role: string, options?: { readonly name?: string; readonly exact?: boolean }): HTMLElement; findByRole(role: string, options?: { readonly name?: string; readonly exact?: boolean }): Promise<HTMLElement> } }) {
    if (canvas.getByRole("heading", { name: "Research", exact: true }).tabIndex !== -1) throw new Error("Route heading needs programmatic focus");
    const navigation = canvas.getByRole("navigation");
    const studio = navigation.querySelector<HTMLAnchorElement>('a[href="/studio"]');
    if (!studio) throw new Error("Stable Studio destination missing");
    studio.click();
    const heading = await canvas.findByRole("heading", { name: "Studio", exact: true });
    if (heading !== document.activeElement) throw new Error("Route commit did not focus the new heading");
    if (studio.getAttribute("aria-current") !== "page") throw new Error("Current destination is not announced");
  },
};
