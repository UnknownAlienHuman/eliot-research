// ER-47 / #337: exercise the observer serialized into the browser and its fail-closed result predicate.
/* global console: readonly */
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { observeShellLayout, hasScrollOwnerFailure } from "../../../scripts/ui-owner/verify.mjs";

const node = (className, extra = {}) => ({ className,
  style: { display: "block", visibility: "visible", overflowY: "visible" },
  clientHeight: 400, scrollHeight: 400, querySelectorAll: () => [],
  getAttribute: () => null, ...extra });
const shell = node("er-shell", { getAttribute: name => name === "lang" ? "ru" : null });
const documentFor = (panes, root = shell) => ({
  querySelector: selector => selector === ".er-shell" ? root : node("html", { getAttribute: () => "en" }),
  querySelectorAll: selector => {
    assert.equal(selector, ".er-pane, .er-shell-sources, .er-shell-reading");
    return panes;
  },
});
const observe = document => observeShellLayout(document, target => target.style);
const reading = node("er-shell-reading", { style: { overflowY: "auto" } });

// Locale follows the rendered root; even a short pane declares its native scroll owner.
const material = observe(documentFor([reading]));
assert.equal(material.locale, "ru");
assert.deepEqual(material.scrollOwners, ["er-shell-reading"]);
assert.equal(material.ownerObservation, "OWNERS_PRESENT");
assert.equal(hasScrollOwnerFailure(material), false);

// Hidden responsive panes and children inside display:none ancestors are excluded.
const hidden = node("er-shell-sources", { hidden: true });
const collapsed = node("er-pane", { getClientRects: () => [] });
assert.equal(observe(documentFor([reading, hidden, collapsed])).panes.length, 1);

// A shell with no panes or an ownerless pane rejects vacuous acceptance.
const missing = observe(documentFor([]));
assert.equal(missing.ownerObservation, "NONE_DECLARED");
assert.equal(hasScrollOwnerFailure(missing), true);
assert.equal(hasScrollOwnerFailure(observe(documentFor([node("er-pane")]))), true);

// Nested active scrolling fails even when the pane root owns scrolling.
const nested = node("card", { style: { overflowY: "auto" }, scrollHeight: 1200 });
const nestedLayout = observe(documentFor([{ ...reading, querySelectorAll: () => [nested] }]));
assert.deepEqual(nestedLayout.scrollOwners, ["er-shell-reading", "card"]);
assert.equal(nestedLayout.panes[0].nestedScrollOwners, 1);
assert.equal(hasScrollOwnerFailure(nestedLayout), true);

// A component story without a workspace shell reports an inapplicable pane contract.
const component = observe(documentFor([], null));
assert.equal(component.shellPresent, false);
assert.equal(component.ownerObservation, "NONE_DECLARED");
assert.equal(hasScrollOwnerFailure(component), false);

// Match page.evaluate serialization without module closures or a second observer implementation.
const serialized = runInNewContext(`(${observeShellLayout.toString()})()`, {
  document: documentFor([reading]), getComputedStyle: target => target.style,
});
assert.deepEqual(JSON.parse(JSON.stringify(serialized)), material);
assert.equal(hasScrollOwnerFailure(serialized), false);

console.log(JSON.stringify({ state: "PASS", cases: 8 }));
