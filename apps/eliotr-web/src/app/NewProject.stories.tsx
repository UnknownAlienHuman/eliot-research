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

export const EmptyProjectBootstrap = {
  render: () => <NewProjectPreview emptyScope />,
  play: async (context: PlayContext) => {
    const probe = await prepare(context);
    await context.canvas.findByText("No sources selected. You can add sources to this project later.");
    if (context.canvasElement.querySelectorAll(".er-live-source-pick li").length !== 0) {
      throw new Error("An empty project unexpectedly acquired a source picker row");
    }
    await context.userEvent.click(context.canvas.getByRole("button", { name: "Create project", exact: true }));
    await until(() => probe.counts().committed.length === 1);
    const counts = probe.counts();
    const body = JSON.parse(counts.createBodies[0] ?? "null") as { title: string; source_ids: string[] };
    if (body.title !== previewTitle || body.source_ids.length !== 0 || counts.createKeys.length !== 1) {
      throw new Error("The first empty project was not created with its exact empty scope");
    }
  },
};

export const LostAcknowledgementRecoversSameIntent = {
  render: () => <NewProjectPreview />,
  play: async (context: PlayContext) => {
    const probe = await prepare(context);
    probe.failCreate("lost-ack");
    await context.userEvent.click(context.canvas.getByRole("button", { name: "Create project", exact: true }));
    const recover = await context.canvas.findByRole("button", { name: "Recover original request", exact: true });
    const beforeRecovery = probe.counts();
    if (beforeRecovery.createKeys.length !== 1 || beforeRecovery.listReads !== 0 || beforeRecovery.committed.length !== 0) {
      throw new Error("The lost acknowledgement triggered an automatic retry or inferred readback");
    }
    await context.userEvent.click(recover);
    await until(() => probe.counts().committed.length === 1);
    const counts = probe.counts();
    if (counts.createKeys.length !== 2 || counts.createKeys[0] !== counts.createKeys[1] ||
        counts.mintedKeys.length !== 1 || counts.createBodies.length !== 2 ||
        counts.createBodies[0] !== counts.createBodies[1] || counts.committed.length !== 1) {
      throw new Error("Recovery changed the original request identity or minted a replacement key");
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
