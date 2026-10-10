import { createHash } from "node:crypto";
import type { VersionedRef, WikiPageRevision } from "@eliotr/contracts";
import { createWikiPublisher, WikiPublicationError, type WikiPublicationPort } from "./wiki.js";
import { describe, expect, it } from "vitest";

// The fixed port supplies this ref; Research does not derive proposal IDs from page bytes.
const PROPOSAL_REF: VersionedRef = { id: "s77-wiki-proposal-001", revision: 1 };
const PAGE_ID = "s77-page-1";
const CANONICAL_MARKER = '"page_ref":{"id":"' + PAGE_ID + '"';
const CONTROL_CHARS = "\u007f\u0085\u2028\u2029";
// Frozen canonical output captured through the saved pre-switch wiki.ts TextEncoder boundary.
const EXPECTED_CANONICAL_JSON =
  '{"body_object_ref":"wiki-body-s77","body_sha256":"' + "a".repeat(64) +
  '","counterposition_refs":[],"coverage_receipt_ref":{"id":"coverage-s77","revision":1},' +
  '"created_at":"2026-10-10T00:00:00.000Z","dependency_refs":["source-revision-s77"],' +
  '"evidence_map_ref":"evidence-map-s77","generator_generation":"wiki-generator-s77","limitations":[],' +
  '"page_ref":{"id":"s77-page-1","revision":1},"page_type":"Source",' +
  '"publication_metadata":{"a":"é","nested":[true,2,null],"z":"\\t' + CONTROL_CHARS + '"},' +
  '"scope_snapshot_ref":{"id":"scope-s77","revision":1},' +
  '"statement_labels":{"claim-s77":"SOURCE_SUPPORTED"},"status":"DRAFT","title":"Wiki\\u0000\\r\\n🚀"}';

interface CanonicalObservation {
  readonly json?: string;
  readonly utf8_bytes: number;
  readonly sha256: string;
}

interface CaptureResult {
  readonly proposal_ref?: VersionedRef;
  readonly saved_page_json?: string;
  readonly save_calls: number;
  readonly canonical: readonly CanonicalObservation[];
  readonly error?: {
    readonly name: string;
    readonly code?: string;
    readonly message: string;
    readonly retryable?: boolean;
  };
}

function page(
  publicationMetadata: Record<string, unknown> = {},
  overrides: Partial<WikiPageRevision> = {},
): WikiPageRevision {
  return {
    page_ref: { id: PAGE_ID, revision: 1 },
    page_type: "Source",
    title: "Source S77",
    scope_snapshot_ref: { id: "scope-s77", revision: 1 },
    body_object_ref: "wiki-body-s77",
    body_sha256: "a".repeat(64),
    statement_labels: { "claim-s77": "SOURCE_SUPPORTED" },
    evidence_map_ref: "evidence-map-s77",
    counterposition_refs: [],
    coverage_receipt_ref: { id: "coverage-s77", revision: 1 },
    limitations: [],
    dependency_refs: ["source-revision-s77"],
    generator_generation: "wiki-generator-s77",
    status: "DRAFT",
    publication_metadata: publicationMetadata,
    created_at: "2026-10-10T00:00:00.000Z",
    ...overrides,
  };
}

async function capture(input: WikiPageRevision, includeCanonicalJson = false): Promise<CaptureResult> {
  let savedPage: WikiPageRevision | undefined;
  let saveCalls = 0;
  const port = {
    async saveProposal(candidate: WikiPageRevision) {
      saveCalls += 1;
      savedPage = structuredClone(candidate);
      return PROPOSAL_REF;
    },
    async readProposal(proposalRef: VersionedRef) {
      return savedPage === undefined
        ? null
        : {
          proposal_ref: proposalRef,
          page: structuredClone(savedPage),
          risk_class: "D1_LOW_RISK_ADDITIVE" as const,
        };
    },
  } as unknown as WikiPublicationPort;

  const observations = new Map<string, CanonicalObservation>();
  const originalEncode = TextEncoder.prototype.encode;
  TextEncoder.prototype.encode = function encodeAndObserve(this: TextEncoder, value?: string) {
    const bytes = originalEncode.call(this, value);
    if (typeof value === "string" && value.includes(CANONICAL_MARKER)) {
      observations.set(value, {
        ...(includeCanonicalJson ? { json: value } : {}),
        utf8_bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    return bytes;
  };

  try {
    const proposalRef = await createWikiPublisher(port).propose(input, "D1_LOW_RISK_ADDITIVE");
    return {
      proposal_ref: proposalRef,
      ...(includeCanonicalJson && savedPage !== undefined ? { saved_page_json: JSON.stringify(savedPage) } : {}),
      save_calls: saveCalls,
      canonical: [...observations.values()],
    };
  } catch (error) {
    return {
      ...(includeCanonicalJson && savedPage !== undefined ? { saved_page_json: JSON.stringify(savedPage) } : {}),
      save_calls: saveCalls,
      canonical: [...observations.values()],
      error: error instanceof WikiPublicationError
        ? { name: error.name, code: error.code, message: error.message, retryable: error.retryable }
        : { name: error instanceof Error ? error.name : "UnknownError", message: String(error) },
    };
  } finally {
    TextEncoder.prototype.encode = originalEncode;
  }
}

function metadataAtDepth(wrapperCount: number): Record<string, unknown> {
  let nested: unknown = null;
  for (let index = 0; index < wrapperCount; index += 1) nested = { nested };
  return { root: nested };
}

function metadataWithNodes(valueCount: number): Record<string, unknown> {
  return Object.fromEntries(
    Array.from({ length: valueCount }, (_, index) => ["node-" + String(index).padStart(4, "0"), null] as const),
  );
}

function firstCanonical(result: CaptureResult): CanonicalObservation {
  const observation = result.canonical[0];
  if (observation === undefined) throw new Error("Wiki caller did not expose canonical page bytes");
  return observation;
}

function digestSummary(result: CaptureResult): { readonly utf8_bytes: number; readonly sha256: string } {
  const { utf8_bytes, sha256 } = firstCanonical(result);
  return { utf8_bytes, sha256 };
}

describe("Wiki shared Unicode validation parity", () => {
  it("preserves historical canonical bytes, store-provided proposal refs, errors, and structure limits", async () => {
    const rich = await capture(
      page(
        { z: "\t\u007f\u0085\u2028\u2029", a: "é", nested: [true, 2, null] },
        { title: "Wiki\u0000\r\n\uD83D\uDE80" },
      ),
      true,
    );
    expect(rich.proposal_ref).toEqual(PROPOSAL_REF);
    expect(rich.save_calls).toBe(1);
    expect(firstCanonical(rich)).toEqual({
      json: EXPECTED_CANONICAL_JSON,
      utf8_bytes: 672,
      sha256: "949b568b605007cb6bc9791b6cb76b0a4e8e3628a025ea274204ad2a12e01e21",
    });
    const savedPage = JSON.parse(rich.saved_page_json ?? "null") as WikiPageRevision;
    expect(savedPage.title).toBe("Wiki\u0000\r\n\uD83D\uDE80");
    expect(savedPage.publication_metadata).toEqual({
      z: "\t\u007f\u0085\u2028\u2029",
      a: "é",
      nested: [true, 2, null],
    });

    const malformed = await capture(page({}, { title: "bad\uD800" }));
    expect(malformed.error).toEqual({
      name: "WikiPublicationError",
      code: "WIKI_INPUT_INVALID",
      message: "wiki revision contains malformed Unicode",
      retryable: false,
    });
    expect(malformed.save_calls).toBe(0);

    const base = await capture(page({ padding: "" }));
    expect(digestSummary(base)).toEqual({
      utf8_bytes: 627,
      sha256: "97f396dcd874cf9d533ef2697a781f3889d3743c63529fa73f680594a4bca20d",
    });
    const exactSize = await capture(page({ padding: "x".repeat(261_517) }));
    expect(exactSize.proposal_ref).toEqual(PROPOSAL_REF);
    expect(digestSummary(exactSize)).toEqual({
      utf8_bytes: 262_144,
      sha256: "b7173ea0753db905972b44196bfb00a2fd54f54ae067423cf6ce185da41a353b",
    });
    const overSize = await capture(page({ padding: "x".repeat(261_518) }));
    expect(digestSummary(overSize)).toEqual({
      utf8_bytes: 262_145,
      sha256: "6b79f65b6c20b6a383b2106106ec45641dccbf0c9e058a57727b674eaada6073",
    });
    expect(overSize.error).toEqual({
      name: "WikiPublicationError",
      code: "WIKI_INPUT_INVALID",
      message: "wiki revision exceeds its canonical byte bound",
      retryable: false,
    });
    expect(overSize.save_calls).toBe(0);

    const depthLimit = await capture(page(metadataAtDepth(14)));
    expect(depthLimit.proposal_ref).toEqual(PROPOSAL_REF);
    expect(digestSummary(depthLimit)).toEqual({
      utf8_bytes: 780,
      sha256: "021f452b1ee7aea7bce6129c4597771f6fcd50856bfa4b287c75a3e39d20ad64",
    });
    const depthOver = await capture(page(metadataAtDepth(15)));
    expect(depthOver.error).toMatchObject({
      name: "WikiPublicationError",
      code: "WIKI_INPUT_INVALID",
      message: "wiki revision exceeds canonical structure bounds",
      retryable: false,
    });
    expect(depthOver.save_calls).toBe(0);

    const nodeLimit = await capture(page(metadataWithNodes(4_071)));
    expect(nodeLimit.proposal_ref).toEqual(PROPOSAL_REF);
    expect(nodeLimit.save_calls).toBe(1);
    expect(digestSummary(nodeLimit)).toEqual({
      utf8_bytes: 69_821,
      sha256: "e70ef88a19dea82afb20b9edeeb9366c755bfa0605f1c4cce533cb4582031350",
    });
    const nodeOver = await capture(page(metadataWithNodes(4_072)));
    expect(nodeOver.error).toMatchObject({
      name: "WikiPublicationError",
      code: "WIKI_INPUT_INVALID",
      message: "wiki revision exceeds canonical structure bounds",
      retryable: false,
    });
    expect(nodeOver.save_calls).toBe(0);

    console.warn("S77_POST_BASELINE=" + JSON.stringify({
      rich: { proposal_ref: rich.proposal_ref, canonical: digestSummary(rich) },
      malformed: malformed.error,
      canonical_bytes: {
        exact: { proposal_ref: exactSize.proposal_ref, canonical: digestSummary(exactSize) },
        over: { canonical: digestSummary(overSize), error: overSize.error },
      },
      depth: {
        limit: { proposal_ref: depthLimit.proposal_ref, canonical: digestSummary(depthLimit) },
        over: depthOver.error,
      },
      nodes: {
        limit: { proposal_ref: nodeLimit.proposal_ref, canonical: digestSummary(nodeLimit) },
        over: nodeOver.error,
      },
    }));
  });
});
