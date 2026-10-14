// ER-47 / #337: the same-SHA visual race must be observable and rejected by the harness itself.
/* global console: readonly */
import assert from "node:assert/strict";
import {
  CANONICAL_STATES,
  TERMINAL_READY_MARKERS,
  DETERMINISM_FIELDS,
  RECEIPT_IDENTITY_FIELDS,
  requireDistinctSameShaBaseline,
  requireTerminalReadyMarker,
  requireCanonicalStates,
  compareDeterministicObservations,
} from "../../../scripts/ui-owner/verify.mjs";

const PREFERENCES = "workspace-shell--material-preferences-journey";

// Every declared journey resolves to exactly one terminal composition whose seed names the presentation the
// harness must observe after the terminal marker. Both declared sets must agree, so a story that declares one
// without the other fails instead of silently falling back to the pre-journey root marker.
assert.equal(CANONICAL_STATES.size, TERMINAL_READY_MARKERS.size,
  "every declared canonical state needs a declared terminal marker and vice versa");
for (const [story, states] of CANONICAL_STATES) {
  assert.ok(TERMINAL_READY_MARKERS.has(story), `${story} declares a canonical state without a terminal marker`);
  assert.equal(TERMINAL_READY_MARKERS.get(story), "data-play-ready", `${story} must declare its terminal marker`);
  assert.deepEqual(requireCanonicalStates(story, CANONICAL_STATES), states, `${story} must keep its terminal composition`);
}
for (const story of TERMINAL_READY_MARKERS.keys()) {
  assert.ok(CANONICAL_STATES.has(story), `${story} declares a terminal marker without a canonical state`);
}

// The terminal state must name the presentation seed it reaches; a missing or malformed seed widens acceptance.
assert.equal(requireCanonicalStates(PREFERENCES, CANONICAL_STATES).theme, "dark");
assert.equal(requireCanonicalStates(PREFERENCES, CANONICAL_STATES).locale, "ru");
assert.equal(requireCanonicalStates(PREFERENCES, CANONICAL_STATES).destination, "studio");
for (const bad of [undefined, null, "initial", ["initial"], {}, { state: "studio-loaded" },
  { state: "studio-loaded", theme: "dark", destination: "studio" },
  { state: "studio-loaded", locale: "ru" },
  { state: "studio-loaded", theme: "dark", locale: "ru" },
  { state: "studio-loaded", locale: "ru", destination: "studio" }]) {
  assert.throws(() => requireCanonicalStates(PREFERENCES, bad), /canonical state|declared|locale|state/);
}
assert.deepEqual(RECEIPT_IDENTITY_FIELDS, ["scenario", "browser", "source_commit", "inputs", "inputs_stable"]);

// A standalone feature story renders no Shell, so it declares a presentation root and must leave the Shell-only
// seeds `unknown`. Declaring a theme or destination for it would assert a value no element carries.
const LIST_FAILURE = "product-studio-live--list-failure-with-selected";
assert.equal(TERMINAL_READY_MARKERS.get(LIST_FAILURE), "data-play-ready");
const standalone = requireCanonicalStates(LIST_FAILURE, CANONICAL_STATES);
assert.equal(standalone.root, ".eliot-token-story");
assert.equal(standalone.theme, "unknown");
assert.equal(standalone.destination, "unknown");
assert.equal(standalone.locale, "en");
for (const bad of [
  { state: "list-failure-selected-visible", theme: "dark", locale: "en", destination: "unknown", root: ".eliot-token-story" },
  { state: "list-failure-selected-visible", theme: "unknown", locale: "en", destination: "studio", root: ".eliot-token-story" },
  { state: "list-failure-selected-visible", theme: "unknown", locale: "en", destination: "unknown", root: "eliot-token-story" },
]) {
  assert.throws(() => requireCanonicalStates(LIST_FAILURE, bad), /unknown|presentation root|declared/);
}
// A Shell story without a declared root keeps the normal seed contract and is not forced into `unknown`.
assert.equal(requireCanonicalStates(PREFERENCES, CANONICAL_STATES).theme, "dark");

// A declared story id is the only way to obtain a ready marker; an unknown story cannot borrow one.
assert.equal(TERMINAL_READY_MARKERS.get(PREFERENCES), "data-play-ready");
assert.equal(TERMINAL_READY_MARKERS.get("workspace-shell--not-a-real-journey"), undefined);
assert.equal(requireTerminalReadyMarker("data-play-ready"), "data-play-ready");
for (const bad of ["", "ready", "dataPlayReady", "data-play-", "data-play-Ready", null, 7]) {
  assert.throws(() => requireTerminalReadyMarker(bad), /Invalid terminal ready marker/);
}

const observation = (width, over = {}) => ({
  // Same shape runBrowser pushes, so a field-name drift between the declared comparator list and the real row
  // fails here instead of silently comparing undefined against undefined.
  width, story: PREFERENCES, state: "preferences-applied", theme: "dark", locale: "ru", destination: "studio",
  overflow: false, focus: "NOT_APPLICABLE", screenshot_sha256: "a".repeat(64), ...over,
});
const attemptA = [observation(1440), observation(320), observation(768, { locale: "en", theme: "light", screenshot_sha256: "b".repeat(64) })];

// Identical same-SHA attempts compare deterministic, and a mismatch in any declared field is reported.
const same = compareDeterministicObservations(attemptA, attemptA.map(row => ({ ...row })));
assert.equal(same.deterministic, true);
assert.deepEqual(same.changed, []);
for (const field of ["theme", "locale", "screenshot_sha256", "overflow", "focus", "destination"]) {
  const value = field === "theme" ? "light" : field === "locale" ? "en" : field === "screenshot_sha256" ? "c".repeat(64) : field === "overflow" ? true : field === "destination" ? "sources" : "PASS real focus journey";
  const changed = compareDeterministicObservations(attemptA, attemptA.map((row, index) => index === 1 ? { ...row, [field]: value } : row));
  assert.equal(changed.deterministic, false, `${field} drift must be observable`);
  assert.equal(changed.changed.length, 1);
  assert.equal(changed.changed[0].field, field);
  assert.equal(changed.changed[0].width, 320);
  const expectedPrevious = field === 'focus' ? null : observation(320)[field];
  assert.equal(changed.changed[0].previous, expectedPrevious);
}

// A changed canonical presentation state is observable. This is the regression that let two same-SHA runs with
// different captured states report a match: the comparator declared `state` while the rows emitted a different key.
const stateDrift = compareDeterministicObservations(attemptA, attemptA.map((row, index) => index === 1 ? { ...row, state: "studio-loaded" } : row));
assert.equal(stateDrift.deterministic, false, "a changed presentation state must be observable");
assert.equal(stateDrift.changed.length, 1);
assert.deepEqual(stateDrift.changed[0], { width: 320, story: PREFERENCES, field: "state", previous: "preferences-applied", current: "studio-loaded" });

// A row that omits a declared field is a harness defect, not an agreement. Same-SHA comparison fails closed.
const [droppedField, ...restOfA] = attemptA;
const incomplete = { ...droppedField };
delete incomplete.screenshot_sha256;
assert.throws(() => compareDeterministicObservations(attemptA, [incomplete, ...restOfA], { requireFields: true }),
  /missing declared determinism fields \(screenshot_sha256\)/);
// Without the same-SHA guard the missing field is reported as a drift rather than passing silently, because the
// absent value differs from the present one. The guard upgrades that to a fail-closed harness error.
const relaxed = compareDeterministicObservations(attemptA, [incomplete, ...restOfA]);
assert.equal(relaxed.deterministic, false);
assert.deepEqual(relaxed.changed.map(entry => entry.field), ["screenshot_sha256"]);

// Comparison never tolerates a difference silently: mismatched cases or order fail closed.
assert.throws(() => compareDeterministicObservations(attemptA, attemptA.slice(0, 2)), /equal case counts/);
assert.throws(() => compareDeterministicObservations(attemptA, [observation(320), observation(1440), observation(768, { locale: "en", theme: "light", screenshot_sha256: "b".repeat(64) })]), /matching width\/story order/);
assert.throws(() => compareDeterministicObservations("nope", attemptA), /two observation arrays/);

// The comparison covers the measured visual surface and the declared presentation state, with no tolerance rule.
assert.deepEqual(DETERMINISM_FIELDS, ["theme", "locale", "destination", "width", "story", "state", "overflow", "focus", "screenshot_sha256"]);
// Every declared field must exist on a real observation row, so a future comparator addition cannot silently no-op.
for (const field of DETERMINISM_FIELDS) assert.ok(Object.hasOwn(observation(1440), field), `real rows must carry ${field}`);

console.log(JSON.stringify({ state: "PASS", cases: 49 }));
// A same-SHA determinism claim needs two genuinely different attempts of one build: a distinct run_attempt,
// stable inputs on both sides, and an identical source-input manifest, or the comparison fails closed before any
// observation is read. This is the binding the CLI previously claimed but never performed.
const manifest = [{ path: "scripts/ui-owner/verify.mjs", sha256: "a".repeat(64) }, { path: "apps/eliotr-web/src/app/Shell.stories.tsx", sha256: "b".repeat(64) }];
const receiptOf = (attempt, over = {}) => ({ run_attempt: attempt, run_attempts_required: 2, inputs: manifest, inputs_stable: true, ...over });
const attemptOne = receiptOf(1);
const attemptTwo = receiptOf(2);
assert.deepEqual(requireDistinctSameShaBaseline(attemptOne, attemptTwo, 2),
  { baseline_attempt: 1, current_attempt: 2, manifest_entries: manifest.length });
assert.throws(() => requireDistinctSameShaBaseline(attemptTwo, attemptTwo, 2), /both are 2/);
assert.throws(() => requireDistinctSameShaBaseline(receiptOf(undefined), attemptTwo, 2), /does not declare its run attempt/);
assert.throws(() => requireDistinctSameShaBaseline(receiptOf(2), attemptTwo, 2), /both are 2/);
assert.throws(() => requireDistinctSameShaBaseline(receiptOf(1, { inputs_stable: false }), attemptTwo, 2), /stable source inputs/);
assert.throws(() => requireDistinctSameShaBaseline(attemptOne, receiptOf(2, { inputs_stable: false }), 2), /stable source inputs/);
assert.throws(() => requireDistinctSameShaBaseline(receiptOf(1, { inputs: manifest.slice(0, 1) }), attemptTwo, 2), /different source-input manifest/);
assert.throws(() => requireDistinctSameShaBaseline(receiptOf(1, { inputs: "not-an-array" }), attemptTwo, 2), /declare their source-input manifest/);
assert.throws(() => requireDistinctSameShaBaseline(receiptOf(1, { run_attempts_required: 3 }), attemptTwo, 2), /different required attempt count/);
assert.throws(() => requireDistinctSameShaBaseline(undefined, attemptTwo, 2), /requires a prior receipt/);
// An older reviewed baseline is another declared source, so the attempt gate deliberately does not apply to it.
assert.equal(RECEIPT_IDENTITY_FIELDS.includes("inputs_stable"), true);

