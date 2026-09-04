import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  AI_SEARCH_CUSTOM_METADATA_FIELDS,
  compileAiSearchCreateRequest,
} from "../../packages/cloudflare-ai/dist/index.js";

const desiredState = JSON.parse(
  await readFile(new URL("./instances.json", import.meta.url), "utf8"),
);

function plainObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function nonemptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function profileFrom(instance, generation) {
  const create = plainObject(instance.create, `${instance.id}.create`);
  const indexMethod = plainObject(
    create.index_method,
    `${instance.id}.create.index_method`,
  );
  const indexing = plainObject(
    create.indexing_options,
    `${instance.id}.create.indexing_options`,
  );
  const retrieval = plainObject(
    create.retrieval_options,
    `${instance.id}.create.retrieval_options`,
  );
  if (!Array.isArray(create.custom_metadata)) {
    throw new Error(`${instance.id}.create.custom_metadata must be an array`);
  }
  const profile = {
    id: instance.id,
    generation,
    index_method: {
      vector: indexMethod.vector,
      keyword: indexMethod.keyword,
    },
    reranking: create.reranking,
    max_num_results: create.max_num_results,
    metadata_fields: create.custom_metadata.map((entry, index) => {
      const metadata = plainObject(
        entry,
        `${instance.id}.create.custom_metadata[${index}]`,
      );
      if (metadata.data_type !== "text") {
        throw new Error(`${instance.id} metadata must use text fields`);
      }
      return nonemptyString(
        metadata.field_name,
        `${instance.id}.create.custom_metadata[${index}].field_name`,
      );
    }),
  };
  if (create.fusion_method !== undefined) {
    profile.fusion_method = create.fusion_method;
  }
  if (indexing.keyword_tokenizer !== undefined) {
    profile.keyword_tokenizer = indexing.keyword_tokenizer;
  }
  if (retrieval.keyword_match_mode !== undefined) {
    profile.keyword_match_mode = retrieval.keyword_match_mode;
  }
  if (create.embedding_model !== undefined) {
    profile.embedding_model = create.embedding_model;
  }
  return profile;
}

function assertDesiredState(raw) {
  const desired = plainObject(raw, "AI Search desired state");
  expect(desired.protocol).toBe("eliotr.ai-search-generation.v1");
  const namespace = nonemptyString(desired.namespace, "namespace");
  const generation = nonemptyString(desired.generation, "generation");
  const generationTag = generation.split("-")[0];
  expect(generationTag).toMatch(/^g[1-9][0-9]*$/u);
  expect(desired.activation_requires).toEqual([
    "T2_PASS",
    "T3_PASS",
    "ITEM_COUNT_READBACK",
    "ROLLBACK_GENERATION_RETAINED",
  ]);
  if (!Array.isArray(desired.instances) || desired.instances.length === 0) {
    throw new Error("instances must be a non-empty array");
  }

  const identifiers = new Set();
  for (const rawInstance of desired.instances) {
    const instance = plainObject(rawInstance, "AI Search instance");
    const id = nonemptyString(instance.id, "instance.id");
    nonemptyString(instance.purpose, `${id}.purpose`);
    if (identifiers.has(id)) throw new Error(`duplicate instance id ${id}`);
    identifiers.add(id);
    expect(id).toMatch(new RegExp(`-${generationTag}$`, "u"));

    const create = plainObject(instance.create, `${id}.create`);
    const compiled = compileAiSearchCreateRequest({
      namespace,
      profile: profileFrom(instance, generation),
      chunk_size: create.chunk_size,
      chunk_overlap: create.chunk_overlap,
    });
    expect(create, `${id} create request differs from typed authority`).toEqual(
      compiled,
    );
    expect(create.custom_metadata).toEqual(
      AI_SEARCH_CUSTOM_METADATA_FIELDS.map((field_name) => ({
        field_name,
        data_type: "text",
      })),
    );
  }
  return desired;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

describe("AI Search desired-state authority", () => {
  it("matches every provider create request to the typed ER-16 compiler", () => {
    expect(assertDesiredState(desiredState)).toBe(desiredState);
  });

  it("rejects the stale source_token/item_key metadata schema", () => {
    const drift = clone(desiredState);
    drift.instances[0].create.custom_metadata[0].field_name = "source_token";
    drift.instances[0].create.custom_metadata[1].field_name = "item_key";
    expect(() => assertDesiredState(drift)).toThrow();
  });

  it("rejects omitted fail-closed provider settings", () => {
    const drift = clone(desiredState);
    delete drift.instances[0].create.cache;
    expect(() => assertDesiredState(drift)).toThrow();
  });

  it("rejects reusing a prior-generation instance identity", () => {
    const drift = clone(desiredState);
    drift.instances[0].id = "private-prose-g1";
    drift.instances[0].create.id = "private-prose-g1";
    expect(() => assertDesiredState(drift)).toThrow(/-g2\$/u);
  });
});
