import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  AI_SEARCH_PRIMARY_GENERATION,
  AI_SEARCH_PRIMARY_INSTANCE_ID,
  AI_SEARCH_PRIMARY_NAMESPACE,
  AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
} from "../../packages/cloudflare-ai/dist/index.js";

const desired = JSON.parse(
  await readFile(new URL("./instances.json", import.meta.url), "utf8"),
);

function projectionProfile(instance) {
  const create = instance.create;
  return {
    id: instance.id,
    generation: desired.generation,
    index_method: create.index_method,
    fusion_method: create.fusion_method,
    keyword_tokenizer: create.indexing_options?.keyword_tokenizer,
    keyword_match_mode: create.retrieval_options?.keyword_match_mode,
    embedding_model: create.embedding_model,
    reranking: create.reranking,
    max_num_results: create.max_num_results,
    metadata_fields: create.custom_metadata.map((entry) => entry.field_name),
  };
}

describe("primary managed projection profile parity", () => {
  it("binds Worker projection to the exact desired namespace, generation and instance", () => {
    expect(desired.namespace).toBe(AI_SEARCH_PRIMARY_NAMESPACE);
    expect(desired.generation).toBe(AI_SEARCH_PRIMARY_GENERATION);
    const matches = desired.instances.filter(
      (instance) => instance.id === AI_SEARCH_PRIMARY_INSTANCE_ID,
    );
    expect(matches).toHaveLength(1);
    expect(projectionProfile(matches[0])).toEqual(
      AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
    );
  });

  it("does not allow a prior instance identity to masquerade as the primary profile", () => {
    expect(AI_SEARCH_PRIMARY_INSTANCE_ID).toMatch(/-g2$/u);
    expect(AI_SEARCH_PRIMARY_INSTANCE_ID).not.toBe("private-prose-g1");
  });
});
