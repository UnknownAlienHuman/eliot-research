import { NewProjectPreview, newProjectPreviewEnvironment, previewTitle, previewSourceIds } from "./NewProjectPreview";

export default { title: "Workspace/New Project", component: NewProjectPreview, parameters: { layout: "fullscreen" } };

interface PlayContext {
  readonly canvasElement: HTMLElement;
  readonly canvas: {
    findByRole(role: string, options: { name: string; exact?: boolean }): Promise<HTMLElement>;
    getByRole(role: string, options: { name: string; exact?: boolean }): HTMLElement;
    getByLabelText(label: string): HTMLElement;
    findByText(text: string): Promise<HTMLElement>;
  };
  readonly userEvent: { click(element: HTMLElement): Promise<void>; type(element: HTMLElement, text: string): Promise<void> };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 180; i++) {
    if (check()) return;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
  throw new Error("New Project did not settle");
}

async function prepare(context: PlayContext) {
  const button = await context.canvas.findByRole("button", { name: "New project", exact: true });
  const root = context.canvasElement.querySelector<HTMLElement>("[data-new-project-preview]");
  if (!root) throw new Error("Preview root absent");
  const environment = newProjectPreviewEnvironment(root);
  if (!environment) throw new Error("Preview environment absent");
  if (environment.probe.counts().mintedKeys.length !== 0) throw new Error("Identity minted without a gesture");
  await context.userEvent.click(button);
  await context.canvas.findByRole("dialog", { name: "Create a project" });
  await context.userEvent.type(context.canvas.getByLabelText("Project title"), previewTitle);
  return environment.probe;
}

export const CanonicalReadbackConfirms = {
  render: () => <NewProjectPreview />,
  play: async (context: PlayContext) => {
    const probe = await prepare(context);
    const create = context.canvas.getByRole("button", { name: "Create project", exact: true });
    await context.userEvent.click(create);
    await until(() => probe.counts().committed.length === 1);
    const counts = probe.counts();
    if (counts.createKeys.length !== 1 || counts.mintedKeys.length !== 1 || counts.createKeys[0] !== counts.mintedKeys[0]) {
      throw new Error("Create did not preserve the explicit gesture's identity");
    }
    const body = JSON.parse(counts.createBodies[0] ?? "null") as { title: string; source_ids: string[] };
    if (body.title !== previewTitle || JSON.stringify(body.source_ids) !== JSON.stringify(previewSourceIds)) throw new Error("Selected scope was not dispatched");
    create.click();
    if (probe.counts().createKeys.length !== 1 || probe.counts().committed.length !== 1) throw new Error("Confirmed project repeated");
  },
};

export const LostAcknowledgementKeepsIdentity = {
  render: () => <NewProjectPreview />,
  play: async (context: PlayContext) => {
    const probe = await prepare(context);
    probe.failCreate("lost-ack");
    await context.userEvent.click(context.canvas.getByRole("button", { name: "Create project", exact: true }));
    const check = await context.canvas.findByRole("button", { name: "Check project status" });
    await context.userEvent.click(check);
    await until(() => probe.counts().listReads === 1);
    const counts = probe.counts();
    if (counts.createKeys.length !== 1 || counts.mintedKeys.length !== 1 || counts.committed.length !== 0) {
      throw new Error("A lost acknowledgement was retried or inferred from an unrelated catalog row");
    }
  },
};

export const ForeignReadbackStaysUnconfirmed = {
  render: () => <NewProjectPreview />,
  play: async (context: PlayContext) => {
    const probe = await prepare(context);
    probe.readbackRow("foreign");
    await context.userEvent.click(context.canvas.getByRole("button", { name: "Create project", exact: true }));
    const check = await context.canvas.findByRole("button", { name: "Check project status" });
    if (probe.counts().committed.length !== 0) throw new Error("Foreign project confirmed");
    probe.readbackRow("canonical");
    await context.userEvent.click(check);
    await until(() => probe.counts().committed.length === 1);
    if (probe.counts().createKeys.length !== 1 || probe.counts().mintedKeys.length !== 1) throw new Error("Reconciliation repeated creation");
  },
};
