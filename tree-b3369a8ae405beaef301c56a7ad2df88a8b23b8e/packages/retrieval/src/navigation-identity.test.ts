import { describe, expect, it } from "vitest";
import { documentMapIdentity, sourceCardIdentity } from "./navigation-identity.js";

const card = {
  "source_revision_ref": "revision-1",
  "title": "Карточка Rust",
  "authors": [
    "Ada"
  ],
  "language": "ru",
  "source_kind": "document",
  "document_role": "primary",
  "authority_hint": "qualified",
  "abstract": "",
  "main_topics": [
    "rust"
  ],
  "controlled_vocabulary": [
    "memory"
  ],
  "outline": [],
  "important_section_refs": [],
  "likely_uses": [],
  "quality_status": "standard",
  "generator_generation": "nav-1",
  "created_at": "2026-09-05T00:00:00.000Z"
};
const map = {
  "source_revision_ref": "revision-1",
  "section_hierarchy": [],
  "page_ranges": [],
  "figures": [],
  "tables": [],
  "named_entities": [],
  "dates_and_versions": [],
  "external_citations": [],
  "key_terms": [],
  "high_information_section_refs": [],
  "unresolved_structure": [],
  "generator_generation": "nav-1",
  "created_at": "2026-09-05T00:00:00.000Z"
};
const digest = "a".repeat(64);
describe("v1 navigation identity parity", () => {
  it("pins the protocol-separated UTF-8 SourceCard identity", async () => {
    expect(await sourceCardIdentity(card, digest)).toEqual({ id: "source-card-22ac0c0f8df17a08df247f7f8a33af8bf2d136bfc8555320", revision: 1 });
    expect(await sourceCardIdentity({ ...card, title: "changed" }, digest)).not.toEqual(await sourceCardIdentity(card, digest));
    expect(await sourceCardIdentity(card, "b".repeat(64))).not.toEqual(await sourceCardIdentity(card, digest));
  });
  it("pins the established DocumentMap identity", async () => {
    expect(await documentMapIdentity(map, digest)).toEqual({ id: "document-map-c8725cfd044dacec862d1cbda82ec84059a77e7ae5b31e1c", revision: 1 });
    expect(await documentMapIdentity(map, "b".repeat(64))).not.toEqual(await documentMapIdentity(map, digest));
  });
  it("rejects protocol override and unknown load-bearing input fields", async () => {
    await expect(sourceCardIdentity({ ...card, protocol: "forged" }, digest)).rejects.toBeInstanceOf(Error);
    await expect(documentMapIdentity({ ...map, future_authority: true }, digest)).rejects.toBeInstanceOf(Error);
    await expect(sourceCardIdentity(card, "not-a-digest")).rejects.toBeInstanceOf(Error);
  });
});
