import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOptions, rejectBaselineAcceptance, requireKnownStory, requireLocalBaseUrl } from "../../../scripts/ui-owner/verify.mjs";

const catalog = {
  scenarios: ["u1-4--primitive-focus", "u1-4--overflow-390", "u1-4--direction"],
};
const index = {
  entries: {
    "u1-4--primitive-focus": { type: "story", name: "Primitive Focus" },
    "u1-4--overflow-390": { type: "story", name: "Overflow 390" },
    "u1-4--direction": { type: "docs", name: "Direction" },
  },
};

test("loopback http base url is accepted", () => {
  assert.equal(requireLocalBaseUrl("http://127.0.0.1:6006").host, "127.0.0.1:6006");
  assert.equal(requireLocalBaseUrl("http://localhost:6006").hostname, "localhost");
});

test("remote and credentialed or query-bearing targets fail", () => {
  assert.throws(() => requireLocalBaseUrl("https://example.invalid/"), /must be http:/);
  assert.throws(() => requireLocalBaseUrl("http://storybook.example.invalid/"), /must be loopback/);
  assert.throws(() => requireLocalBaseUrl("http://user:pw@127.0.0.1:6006"), /credentials/);
  assert.throws(() => requireLocalBaseUrl("http://127.0.0.1:6006?story=1"), /query or hash/);
  assert.throws(() => requireLocalBaseUrl("http://127.0.0.1:6006/#story"), /query or hash/);
});

test("story must be catalogued and present as a story in the live index", () => {
  const entry = requireKnownStory("u1-4--primitive-focus", catalog, index);
  assert.equal(entry.name, "Primitive Focus");
  assert.throws(() => requireKnownStory("u1-4--missing", catalog, index), /unknown catalog story id/);
  assert.throws(() => requireKnownStory("u1-4--direction", catalog, index), /is not a story/);
  const noEntry = { entries: {} };
  assert.throws(() => requireKnownStory("u1-4--overflow-390", catalog, noEntry), /absent from live index/);
});

test("baseline auto-acceptance is rejected in every spelling", () => {
  assert.equal(rejectBaselineAcceptance({}), true);
  assert.throws(() => rejectBaselineAcceptance({ acceptBaseline: true }), /forbidden/);
  assert.throws(() => rejectBaselineAcceptance({ accept_baseline: true }), /forbidden/);
  assert.throws(() => rejectBaselineAcceptance({ "accept-baseline": true }), /forbidden/);
});

test("real catalog scenario groups bind to the live index", () => {
  assert.equal(requireKnownStory("u1-4--primitive-focus", { scenarios: { foundation: ["u1-4--primitive-focus"] } }, index).name, "Primitive Focus");
});

test("unknown, duplicated or incomplete CLI options and snapshot updates reject", () => {
  assert.deepEqual(parseOptions(["--scenario", "u1-direction"]), { scenario: "u1-direction" });
  for (const args of [["--accept-baseline"], ["--update-snapshot"], ["--scenaro", "u1-direction"], ["--scenario"], ["--scenario", "a", "--scenario", "b"]]) assert.throws(() => parseOptions(args));
});
