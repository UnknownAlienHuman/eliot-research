import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PROJECTION_EXECUTION_PROFILE } from
  "../apps/eliotr-core/src/projection-execution-handler.js";

interface DesiredInstance {
  readonly id: string;
  readonly purpose: string;
}

interface DesiredAiSearchState {
  readonly protocol: string;
  readonly generation: string;
  readonly instances: readonly DesiredInstance[];
}

const desired = JSON.parse(
  await readFile(
    new URL("../infra/ai-search/instances.json", import.meta.url),
    "utf8",
  ),
) as DesiredAiSearchState;

describe("projection managed-generation profile parity", () => {
  it("targets the declared private prose instance and generation", () => {
    expect(desired.protocol).toBe("eliotr.ai-search-generation.v1");
    const privateProse = desired.instances.filter(
      (instance) =>
        instance.purpose === "private natural-language source sections",
    );
    expect(privateProse).toHaveLength(1);
    expect(PROJECTION_EXECUTION_PROFILE.managed_instance_id).toBe(
      privateProse[0]?.id,
    );
    expect(PROJECTION_EXECUTION_PROFILE.managed_generation).toBe(
      desired.generation,
    );
    expect(PROJECTION_EXECUTION_PROFILE.managed_generation_active).toBe(false);
  });

  it("keeps generation activation outside static desired state", () => {
    expect(PROJECTION_EXECUTION_PROFILE.managed_generation_active).toBe(false);
    expect(desired).not.toHaveProperty("active");
    expect(desired).not.toHaveProperty("promoted");
  });
});
