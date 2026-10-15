import { describe, expect, it, vi } from "vitest";
import type { ProjectListView, ProjectMutationView, ProjectSummary } from "@eliotr/owner-api-client";
import type { BoundWorkspaceApis } from "../app/runtime";
import type { PrivacyController, SessionContext } from "../app/privacy";
import {
  createExistingProjectAttachmentController,
  freezeProjectAttachmentTarget,
  type ProjectAttachmentState,
} from "./projectAttachment";

const generation = "generation-1";
const stamp = "2026-10-15T00:00:00.000Z";

function project(id: string, sources: readonly string[], revision = 2, title = "Research project"): ProjectSummary {
  return { project_id: id, title, revision, source_ids: [...sources].sort(), created_at: stamp };
}

function page(rows: readonly ProjectSummary[]): ProjectListView {
  return { protocol: "eliotr.project-owner-list.v1", deployment_generation: generation, projects: rows };
}

function mutation(row: ProjectSummary): ProjectMutationView {
  return { protocol: "eliotr.project-owner.v1", state: "UPDATED", project: row, deployment_generation: generation };
}

function setup(options: {
  readonly current?: () => boolean;
  readonly update?: ReturnType<typeof vi.fn>;
  readonly read?: ReturnType<typeof vi.fn>;
  readonly target?: ReturnType<typeof freezeProjectAttachmentTarget>;
} = {}) {
  let state: ProjectAttachmentState | undefined;
  const update = options.update ?? vi.fn(async () => mutation(project("project-a", ["source-old", "source-new"], 3)));
  const read = options.read ?? vi.fn(async () => page([project("project-a", ["source-old", "source-new"], 3)]));
  const apis = {
    mintIntent: vi.fn(() => "membership-intent-1"),
    projects: { updateProject: update, readProjects: read },
  } as unknown as BoundWorkspaceApis["sources"];
  const privacy = { isCurrent: options.current ?? (() => true) } as unknown as PrivacyController;
  const context = { deploymentGeneration: generation } as SessionContext;
  const store = {
    read: () => state,
    write: (next: ProjectAttachmentState) => { state = next; },
  };
  const target = options.target ?? freezeProjectAttachmentTarget(project("project-a", ["source-old"]), generation);
  const controller = createExistingProjectAttachmentController(apis, privacy, context, target, store);
  return { controller, state: () => state, update, read, apis, store, context, privacy };
}

const signal = () => new AbortController().signal;

describe("existing project source attachment", () => {
  it.each([2, 3])("confirms duplicate membership only from a current canonical read at revision %i without PUT", async revision => {
    const currentProject = project("project-a", ["source-new", "source-old"], revision);
    const read = vi.fn(async () => page([currentProject]));
    const target = freezeProjectAttachmentTarget(project("project-a", ["source-new", "source-old"], 2), generation);
    const test = setup({ target, read });

    const result = await test.controller.attach("source-new", signal());
    expect(result?.phase).toBe("confirmed");
    expect(result?.project).toBe(currentProject);
    expect(read).toHaveBeenCalledTimes(1);
    expect(test.update).not.toHaveBeenCalled();
    expect(test.apis.mintIntent).not.toHaveBeenCalled();
  });

  it("preserves a duplicate import as unresolved after concurrent source removal without re-adding it", async () => {
    const target = freezeProjectAttachmentTarget(project("project-a", ["source-new", "source-old"], 2), generation);
    const read = vi.fn(async () => page([project("project-a", ["source-old"], 3)]));
    const test = setup({ target, read });

    const result = await test.controller.attach("source-new", signal());
    expect(result?.phase).toBe("conflict");
    expect(result?.intent.sourceId).toBe("source-new");
    expect(result?.intent.sourceIds).toEqual(["source-new", "source-old"]);
    expect((await test.controller.readStatus(signal()))?.phase).toBe("conflict");
    expect(test.state()?.intent).toBe(result?.intent);
    expect(test.update).not.toHaveBeenCalled();
    expect(test.apis.mintIntent).not.toHaveBeenCalled();
  });

  it("adds the canonical committed source to the frozen selected project", async () => {
    const test = setup();
    const result = await test.controller.attach("source-new", signal());
    expect(result?.phase).toBe("confirmed");
    expect(test.update).toHaveBeenCalledTimes(1);
    expect(test.update).toHaveBeenCalledWith("project-a", "Research project", ["source-new", "source-old"], 2,
      "membership-intent-1", generation, expect.any(AbortSignal));
    expect(test.apis.mintIntent).toHaveBeenCalledTimes(1);
    expect(test.state()?.intent.sourceId).toBe("source-new");
  });

  it("keeps the file-selection project across a project switch and blocks a changed authority", async () => {
    let selectedProjectId = "project-a";
    const frozenAtSelection = freezeProjectAttachmentTarget(project(selectedProjectId, ["source-old"]), generation);
    const test = setup({ target: frozenAtSelection });
    selectedProjectId = "project-b";
    await test.controller.attach("source-new", signal());
    expect(test.update).toHaveBeenCalledWith("project-a", "Research project", ["source-new", "source-old"], 2,
      "membership-intent-1", generation, expect.any(AbortSignal));
    expect(selectedProjectId).toBe("project-b");

    const revoked = setup({ current: () => false });
    await revoked.controller.attach("source-new", signal());
    expect(revoked.update).not.toHaveBeenCalled();
    expect(revoked.state()).toBeUndefined();
  });

  it("reconciles one unknown intent by readback and never sends a second PUT", async () => {
    const update = vi.fn(async () => { throw new Error("acknowledgement lost"); });
    let attached = false;
    const read = vi.fn(async () => page([project("project-a", attached ? ["source-new", "source-old"] : ["source-old"], attached ? 3 : 2)]));
    const test = setup({ update, read });

    expect((await test.controller.attach("source-new", signal()))?.phase).toBe("unknown");
    const originalIntent = test.state()?.intent;
    expect(originalIntent?.idempotencyKey).toBe("membership-intent-1");
    expect((await test.controller.readStatus(signal()))?.phase).toBe("unknown");
    expect(update).toHaveBeenCalledTimes(1);
    attached = true;
    expect((await test.controller.readStatus(signal()))?.phase).toBe("confirmed");
    expect(test.state()?.intent).toBe(originalIntent);
    expect(update).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
