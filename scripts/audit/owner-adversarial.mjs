// Retained audit harness. The target module lives on agent/launch-01-library-20260905
// (PR #98); point ELIOTR_AUDIT_REPO at a checkout of that branch, or run from it.
// See README.md.
import assert from "node:assert/strict";
import nodePath from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const repo = process.env.ELIOTR_AUDIT_REPO ?? fileURLToPath(new URL("../..", import.meta.url));
const { assertAuthedLedger, createClosedAuthority } =
  await import(pathToFileURL(nodePath.join(repo, "tests/integration/browser/owner-e2e.mjs")).href);

const origin = "http://127.0.0.1:1234";
const path = "/api/v1/research/catalog?limit=20";

function fixture({ abortDocId = 1, survivorDocId = 2, duplicateResponse = false, seqSwap = false } = {}) {
  const auth = createClosedAuthority("adversarial");
  const root = auth.registerOp({ kind: "init", cause: "harness-start", scope: "harness",
    sourceDoc: 0, targetDoc: 0, action: "harness-start", role: "startup-probe",
    successors: ["probe-issue"] });
  const pre = auth.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
    sourceDoc: 1, targetDoc: 1, action: "probe-issue", role: "catalog-read",
    from: root.id, successors: ["probe-retry"] });
  const post = auth.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
    sourceDoc: 1, targetDoc: 2, action: "probe-retry", role: "catalog-read",
    from: pre.id, successors: [] });
  const abortSlot = auth.mintSlot({ opId: pre.id, targetDoc: 1, action: pre.action, role: pre.role,
    method: "GET", origin, path });
  const survivorSlot = auth.mintSlot({ opId: post.id, targetDoc: 2, action: post.action, role: post.role,
    method: "GET", origin, path });
  const abort = { method: "GET", origin, path, resourceType: "fetch", reqId: 1, opId: pre.id,
    docId: abortDocId, role: "catalog-read", slotId: abortSlot.id, seq: seqSwap ? 2 : 1 };
  const survivor = { method: "GET", origin, path, resourceType: "fetch", reqId: 2, opId: post.id,
    docId: survivorDocId, role: "catalog-read", slotId: survivorSlot.id, seq: seqSwap ? 1 : 2 };
  const response = { ...survivor, status: 200, contentType: "application/json" };
  const failure = { ...abort, errorText: "net::ERR_ABORTED", text: `GET ${origin}${path} :: net::ERR_ABORTED` };
  const harness = {
    consoleErrors: [], pageErrors: [], failedRequests: [failure.text],
    failedRequestEntries: [failure], requests: [abort, survivor],
    networkResponses: duplicateResponse ? [response, { ...response }] : [response],
    operationTable: () => auth.operations(), edgeTable: () => auth.edges(), slotTable: () => auth.slots(),
  };
  return harness;
}

const results = {};
try {
  assert.doesNotThrow(() => assertAuthedLedger(fixture({ abortDocId: 999 }), "doc-mismatch", origin));
  results.operationDocumentMismatch = "ACCEPTED (unexpected)";
} catch (error) { results.operationDocumentMismatch = `rejected: ${error.message}`; }
try {
  assert.doesNotThrow(() => assertAuthedLedger(fixture({ duplicateResponse: true }), "dup-response", origin));
  results.duplicateResponseIdentity = "ACCEPTED (unexpected)";
} catch (error) { results.duplicateResponseIdentity = `rejected: ${error.message}`; }
try {
  assert.doesNotThrow(() => assertAuthedLedger(fixture({ seqSwap: true }), "seq-order", origin));
  results.responseBeforeAbortSeq = "ACCEPTED (ordering not checked)";
} catch (error) { results.responseBeforeAbortSeq = `rejected: ${error.message}`; }

const nav = createClosedAuthority("pending-nav");
const root = nav.registerOp({ kind: "init", cause: "harness-start", scope: "harness", sourceDoc: 0,
  targetDoc: 0, action: "harness-start", role: "startup-probe", successors: ["goto-unauthenticated"] });
const first = nav.registerOp({ kind: "harness-navigation", cause: "goto", scope: "document", sourceDoc: 0,
  targetDoc: 1, action: "goto-unauthenticated", role: "startup-probe", from: root.id,
  successors: ["framenavigated"] });
const second = nav.registerOp({ kind: "harness-navigation", cause: "goto", scope: "document", sourceDoc: 0,
  targetDoc: 1, action: "goto-unauthenticated", role: "startup-probe", from: root.id,
  successors: ["framenavigated"] });
const consumed = nav.consumeNavSlot(1);
results.pendingNavigationSelection = { expected: first.id, actual: consumed?.opId, positionalMostRecent: consumed?.opId === second.id };
console.log(JSON.stringify(results, null, 2));
