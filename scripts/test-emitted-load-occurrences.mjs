/**
 * Focused tests for the module load occurrence inventory.
 *
 * These tests check the inventory contract only: what each occurrence is,
 * where it sits in source, which literal it names, and which forms stay
 * unresolved. They assert the inventory does not claim runtime semantics, so
 * they never require the returned value to say anything about evaluation,
 * worker eagerness, lazy dynamic imports, preload evaluation or a complete
 * runtime module graph.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { LOAD_OCCURRENCE_OFFSET_UNIT, collectModuleLoadOccurrences,
  LOAD_OCCURRENCE_KINDS, UNRESOLVED_LOAD_REASONS } from "./lib/emitted-load-occurrences.mjs";

let cases = 0;

function check(name, action) {
  action();
  cases += 1;
  console.log("emitted load occurrences: " + name + ": PASS");
}

/** One minified emitted bundle exercising every supported form at once. */
const MINIFIED = [
  'import"./chunk-a.js";',
  'import b from"./chunk-b.js";',
  'export{c}from"./chunk-c.js";',
  'const p=import("./chunk-d.js");',
  'new Worker(new URL("./chunk-e.js",import.meta.url),{type:"module"});',
  'new SharedWorker(new URL("./chunk-f.js",import.meta.url));',
].join("");

check("every emitted form is inventoried with its exact range and literal", () => {
  const inventory = collectModuleLoadOccurrences(MINIFIED, "assets/index-CjWjI3ks.js");

  assert.equal(inventory.sourceSha256,
    createHash("sha256").update(Buffer.from(MINIFIED, "utf8")).digest("hex"));
  assert.equal(inventory.utf8Bytes, Buffer.byteLength(MINIFIED, "utf8"));

  assert.deepEqual(inventory.staticImports, ["./chunk-a.js", "./chunk-b.js", "./chunk-c.js"]);
  assert.deepEqual(inventory.dynamicImports, ["./chunk-d.js"]);
  assert.deepEqual(inventory.workerImports, ["./chunk-e.js", "./chunk-f.js"]);
  assert.deepEqual(inventory.unresolved, []);

  assert.deepEqual(
    inventory.occurrences.map((occurrence) => occurrence.kind),
    [
      LOAD_OCCURRENCE_KINDS.staticImport,
      LOAD_OCCURRENCE_KINDS.staticImport,
      LOAD_OCCURRENCE_KINDS.reExport,
      LOAD_OCCURRENCE_KINDS.dynamicImport,
      LOAD_OCCURRENCE_KINDS.workerConstructor,
      LOAD_OCCURRENCE_KINDS.sharedWorkerConstructor,
    ],
  );
  for (const occurrence of inventory.occurrences) {
    assert.ok(Number.isSafeInteger(occurrence.start), "start must be a UTF-16 source offset");
    assert.ok(Number.isSafeInteger(occurrence.end), "end must be a UTF-16 source offset");
    assert.ok(occurrence.start < occurrence.end, "an occurrence range must be non-empty");
    assert.ok(occurrence.end <= MINIFIED.length, "an occurrence must stay inside the source");
    const sliced = MINIFIED.slice(occurrence.start, occurrence.end);
    if (occurrence.specifier === null) {
      assert.ok(sliced.includes("Worker"),
        "an unresolved worker occurrence still anchors at the constructor");
    } else {
      // A literal range includes its quotation marks, so the specifier is compared
      // against the sliced text and not against it verbatim. Each kind anchors at
      // the exact node it records: an import or re-export slices to its module
      // specifier literal, a dynamic import to its first argument, and a worker
      // constructor to the whole constructor expression.
      const quoted = JSON.stringify(occurrence.specifier);
      const worker = occurrence.kind === LOAD_OCCURRENCE_KINDS.workerConstructor ||
        occurrence.kind === LOAD_OCCURRENCE_KINDS.sharedWorkerConstructor;
      // The recorded range is the source-node range, so it covers the literal
      // including its quotation marks and is never trimmed to the decoded text.
      assert.ok(worker ? sliced.includes(quoted.slice(1, -1)) : sliced === quoted,
        "the recorded range must match the anchor node for its kind");
    }
  }
});

check("duplicate occurrences are each retained", () => {
  const source = 'import"./same.js";import"./same.js";import"./same.js";';
  const inventory = collectModuleLoadOccurrences(source, "assets/duplicate.js");
  assert.equal(inventory.occurrences.length, 3, "each actual occurrence survives");
  assert.deepEqual(inventory.staticImports, ["./same.js", "./same.js", "./same.js"],
    "the compatibility array keeps duplicates too");
});

check("computed dynamic import and computed worker URL stay unresolved", () => {
  const source = [
    'const n=1,name="./other.js";',
    'import("./x"+n+".js");',
    'import(name);',
    'new Worker(new URL(name,import.meta.url));',
    'import(cond?"./a.js":"./b.js");',
  ].join("");
  const inventory = collectModuleLoadOccurrences(source, "assets/computed.js");
  assert.equal(inventory.occurrences.length, 4);
  assert.deepEqual(inventory.staticImports, []);
  assert.deepEqual(inventory.dynamicImports, []);
  assert.deepEqual(inventory.workerImports, []);
  assert.deepEqual(inventory.unresolved, [
    UNRESOLVED_LOAD_REASONS.dynamicImport,
    UNRESOLVED_LOAD_REASONS.dynamicImport,
    UNRESOLVED_LOAD_REASONS.workerUrl,
    UNRESOLVED_LOAD_REASONS.dynamicImport,
  ]);
  for (const occurrence of inventory.occurrences) assert.equal(occurrence.specifier, null);
});

check("the exact standard direct Worker and SharedWorker URLs are edges", () => {
  const source = [
    'new Worker(new URL("./w.js",import.meta.url));',
    'new SharedWorker(new URL("./s.js",import.meta.url));',
  ].join("\n");
  const inventory = collectModuleLoadOccurrences(source, "assets/direct-workers.js");
  assert.deepEqual(inventory.workerImports, ["./w.js", "./s.js"],
    "the direct standard constructor URL must be a literal inventory edge");
  assert.deepEqual(inventory.unresolved, [],
    "a direct standard constructor URL is not an unresolved edge");
  assert.deepEqual(
    inventory.occurrences.map((occurrence) => occurrence.specifier),
    ["./w.js", "./s.js"]);
});
check("a nested URL is never attributed to a worker constructor", () => {
  const source = 'function holder(){return new URL("./nested.js",import.meta.url)};' +
    'new Worker(holder());';
  const inventory = collectModuleLoadOccurrences(source, "assets/nested.js");
  assert.equal(inventory.occurrences.length, 1, "the nested URL is not an occurrence");
  assert.equal(inventory.occurrences[0].kind, LOAD_OCCURRENCE_KINDS.workerConstructor);
  assert.equal(inventory.occurrences[0].specifier, null,
    "an arbitrary nested URL cannot name the constructor specifier");
  assert.deepEqual(inventory.workerImports, []);
  assert.deepEqual(inventory.unresolved, [UNRESOLVED_LOAD_REASONS.workerUrl]);
  assert.ok(!inventory.staticImports.includes("./nested.js"));
});

check("unsupported worker argument shapes fail closed", () => {
  const shapes = [
    'new Worker(new URL("./a.js",import.meta));',
    'new Worker(new URL("./a.js",import.meta.other));',
    'new Worker(new URL("./a.js",import.meta.url),new URL("./nested.js",import.meta.url));',
    'new Worker(new URL("./a.js"));',
    'new Worker(new URL("./a.js",other.url));',
    'new Worker("./a.js",{type:"module"});',
    'new Worker();',
    'new SharedWorker(new URL("./a.js",import.meta.url),{});',
  ];
  const inventory = collectModuleLoadOccurrences(shapes.join("\n"), "assets/workers.js");
  assert.equal(inventory.occurrences.length, shapes.length);
  assert.deepEqual(inventory.occurrences.map((occurrence) => occurrence.specifier),
    [null, null, "./a.js", null, null, null, null, "./a.js"]);
  // Only the exact direct standard form resolves, and a nested URL in a later
  // argument is never attributed to the constructor.
  assert.deepEqual(inventory.workerImports, ["./a.js", "./a.js"]);
  assert.ok(!inventory.workerImports.includes("./nested.js"),
    "a nested URL is never attributed to the worker constructor");
  assert.equal(inventory.unresolved.filter((reason) =>
    reason === UNRESOLVED_LOAD_REASONS.workerUrl).length, 6);
});

check("malformed syntax fails closed instead of guessing an inventory", () => {
  const source = 'import"./a.js" from; const = ; new Worker(new URL("./b.js",import.meta.url)';
  assert.throws(
    () => collectModuleLoadOccurrences(source, "assets/malformed.js"),
    /could not be parsed/u,
    "a syntax error must not silently produce a partial inventory");
});

check("UTF-8 and UTF-16 offsets stay exact and agree with the source bytes", () => {
  const prefix = 'const s="é中U0001F600";';
  const source = prefix + 'import"./é中.js";import"./b.js";';
  const inventory = collectModuleLoadOccurrences(source, "assets/unicode.js");

  assert.equal(inventory.utf8Bytes, Buffer.byteLength(source, "utf8"));
  assert.equal(inventory.offsetUnit, LOAD_OCCURRENCE_OFFSET_UNIT,
    "the returned inventory must name the unit of its start/end values");
  assert.equal(LOAD_OCCURRENCE_OFFSET_UNIT, "UTF16 code units");
  assert.ok(Buffer.byteLength(source, "utf8") > source.length,
    "multi-byte source must not be treated as ASCII");
  assert.deepEqual(inventory.staticImports, ["./é中.js", "./b.js"]);

  const occurrence = inventory.occurrences.find((entry) =>
    entry.specifier === "./é中.js");
  // The recorded range is the source-node range, so it covers the literal including
  // its quotation marks and is compared against the raw source literal rather than
  // the decoded specifier text.
  const rawLiteral = '"./é中.js"';
  assert.equal(source.slice(occurrence.start, occurrence.end), rawLiteral,
    "the UTF-16 range must slice to the exact raw literal including quotes");
  const second = inventory.occurrences.find((entry) => entry.specifier === "./b.js");
  assert.ok(occurrence.end <= second.start, "ranges stay in source order");
  assert.ok(occurrence.start >= prefix.length,
    "a multi-byte prefix shifts the UTF-16 offsets correctly");
});

check("the inventory never claims runtime module semantics", () => {
  const source = [
    'import"./static.js";',
    'if(false)import("./guarded.js");',
    'new Worker(new URL("./worker.js",import.meta.url));',
  ].join("");
  const inventory = collectModuleLoadOccurrences(source, "assets/guarded.js");
  const serialized = JSON.stringify(inventory);
  for (const forbidden of ["eager", "lazy", "preload", "evaluat", "runtime", "complete"]) {
    assert.ok(!serialized.includes(forbidden),
      "the inventory must not carry a runtime-semantics token: " + forbidden);
  }
  assert.deepEqual(inventory.dynamicImports, ["./guarded.js"],
    "a guarded dynamic import is still an occurrence, not a lazy verdict");
  assert.deepEqual(inventory.workerImports, ["./worker.js"],
    "a worker constructor is still an occurrence, not an eagerness verdict");
  assert.deepEqual(inventory.unresolved, []);
});

console.log("emitted load occurrences: " + cases + " checks: PASS");
