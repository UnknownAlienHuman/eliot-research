// Pure visual terminal-state and receipt comparison capability. No browser or filesystem access.
/**
 * One deterministic terminal composition per story.
 *
 * A journey's play function performs asynchronous work that changes theme, locale and route. Two jobs on one
 * source SHA could previously observe either the initial view or the finished journey, so the harness captured a
 * frame that had nothing to do with the source being reviewed. Each declared story now resolves to exactly one
 * canonical state, and that state names the presentation seed it must reach: theme, locale and destination. The
 * harness waits for the story's own terminal marker, then observes and asserts those declared seed values, so a
 * frame captured mid-journey or against the wrong presentation is a failure rather than a passing baseline.
 *
 * Only declared stories are eligible. A story that is not listed here has no declared terminal composition and
 * cannot silently borrow a default one.
 */
export const CANONICAL_STATES = new Map([
  ["workspace-shell--material-preferences-journey", { state: "preferences-applied", theme: "dark", locale: "ru", destination: "studio" }],
  ["workspace-shell--material-reading-journey", { state: "reading-composed", theme: "light", locale: "en", destination: "studio" }],
  ["workspace-shell--live-sources-journey", { state: "reader-open", theme: "light", locale: "en", destination: "sources" }],
  ["workspace-shell--live-research-journey", { state: "research-started", theme: "light", locale: "en", destination: "research" }],
  ["workspace-shell--live-studio-journey", { state: "studio-loaded", theme: "light", locale: "en", destination: "studio" }],
  ["workspace-shell--research-operation-announcements", { state: "announcement-live", theme: "light", locale: "en", destination: "research" }],
  ["workspace-shell--studio-operation-announcements", { state: "announcement-live", theme: "light", locale: "en", destination: "studio" }],
  ["workspace-shell--connections-operation-announcements", { state: "announcement-live", theme: "light", locale: "en", destination: "connections" }],
  // Standalone feature stories render inside a `.eliot-token-story` decorator, not the workspace Shell, so they own
  // no `data-theme` and no destination. Their theme follows `prefers-color-scheme` at the document level, which no
  // story switch pins, so the theme seed is declared unknown rather than faked from a Shell that is not there.
  // `locale` is declared because the feature renders `lang={locale}` itself and the harness can read it.
  ["product-studio-live--list-failure-with-selected", { state: "list-failure-selected-visible", theme: "unknown", locale: "en", destination: "unknown", root: ".eliot-token-story" }],
  ["product-studio-live--body-loading", { state: "body-loading", theme: "unknown", locale: "en", destination: "unknown", root: ".eliot-token-story" }],
]);

/**
 * A story declares its own terminal readiness. The harness waits for that marker and resets the observed
 * theme/locale/route/content seed before observing; it never substitutes a clock for declared readiness.
 */
export const TERMINAL_READY_MARKERS = new Map([
  ["workspace-shell--material-preferences-journey", "data-play-ready"],
  ["workspace-shell--material-reading-journey", "data-play-ready"],
  ["workspace-shell--live-sources-journey", "data-play-ready"],
  ["workspace-shell--live-research-journey", "data-play-ready"],
  ["workspace-shell--live-studio-journey", "data-play-ready"],
  ["workspace-shell--research-operation-announcements", "data-play-ready"],
  ["workspace-shell--studio-operation-announcements", "data-play-ready"],
  ["workspace-shell--connections-operation-announcements", "data-play-ready"],
  ["product-studio-live--list-failure-with-selected", "data-play-ready"],
  ["product-studio-live--body-loading", "data-play-ready"],
]);

/** Only a declared marker shape is accepted; a misspelled readiness signal cannot be ignored. */
export function requireTerminalReadyMarker(marker) {
  const value = typeof marker === "string" ? marker.trim() : "";
  if (!/^data-play-[a-z][a-z0-9-]*$/u.test(value)) throw new TypeError(`Invalid terminal ready marker: ${value}`);
  return value;
}

/** The declared presentation seed a canonical state must reach; a missing seed would widen acceptance. */
export function requireCanonicalStates(story, states) {
  const terminal = states instanceof Map ? states.get(story) : states;
  if (terminal === undefined || terminal === null) throw new RangeError(`Story has no declared canonical state: ${story}`);
  if (typeof terminal !== "object" || Array.isArray(terminal)) throw new TypeError(`Canonical state must be one declared terminal view: ${story}`);
  if (typeof terminal.state !== "string" || !/^[a-z][a-z0-9-]*$/u.test(terminal.state)) throw new TypeError(`Invalid canonical state: ${story}`);
  for (const field of ["theme", "destination"]) {
    if (typeof terminal[field] !== "string" || terminal[field] === "") throw new TypeError(`Missing declared ${field} for canonical state: ${story}`);
  }
  if (Array.isArray(terminal.locale)) {
    for (const locale of terminal.locale) if (typeof locale !== "string" || !/^[a-z]{2}$/u.test(locale)) throw new TypeError(`Invalid declared locale: ${story}`);
  } else if (typeof terminal.locale !== "string" || !/^[a-z]{2}$/u.test(terminal.locale)) {
    throw new TypeError(`Missing declared locale for canonical state: ${story}`);
  }
  // A standalone feature story renders no Shell, so it declares no destination and its theme follows the
  // document color scheme rather than a story-owned switch. `unknown` is the only permitted placeholder: the
  // harness then refuses to assert that seed instead of inventing a value it never observed.
  for (const field of ["theme", "destination"]) {
    if (terminal[field] !== "unknown" && !/^[a-z][a-z0-9-]*$/u.test(terminal[field])) throw new TypeError(`Invalid declared ${field}: ${story}`);
  }
  if (terminal.root !== undefined && !/^\.[a-z][a-z0-9-]*$/u.test(terminal.root)) throw new TypeError(`Invalid declared presentation root: ${story}`);
  // A declared standalone presentation root must not also declare Shell-only seeds. Declaring a theme or a
  // destination for a story that renders no Shell would let the harness assert a value no element carries.
  if (typeof terminal.root === "string" && terminal.root !== ".er-shell") {
    for (const field of ["theme", "destination"]) {
      if (terminal[field] !== "unknown") throw new TypeError(`Standalone root must declare ${field} unknown: ${story}`);
    }
  }
  return { ...terminal };
}

/** Same-SHA determinism compares declared observations with no tolerance-based auto-acceptance. */
export const DETERMINISM_FIELDS = ["theme", "locale", "destination", "width", "story", "state", "overflow", "focus", "screenshot_sha256"];

/**
 * Fields describing the conditions under which a receipt was produced, rather than the observation itself.
 * Same-SHA determinism requires these to match exactly; an older reviewed baseline is compared only on
 * observation fields, because a legitimate change between an accepted earlier source and the current one is exactly
 * what a visual baseline exists to reveal.
 */
export const RECEIPT_IDENTITY_FIELDS = ["scenario", "browser", "source_commit", "inputs", "inputs_stable"];

/**
 * Two receipts on one source SHA are a determinism claim only if they are two genuinely different attempts of that
 * same build. This runs before any observation is compared, so a self-baseline, a repeated attempt id or a
 * different source-input manifest fails closed instead of producing another green PASS artifact.
 */
export function requireDistinctSameShaBaseline(baseline, receipt, currentAttempt) {
  if (!baseline || typeof baseline !== "object") throw new TypeError("Same-SHA baseline requires a prior receipt");
  if (baseline.run_attempt === undefined || baseline.run_attempt === null) {
    throw new TypeError("Same-SHA baseline receipt does not declare its run attempt");
  }
  if (baseline.run_attempt === currentAttempt) {
    throw new RangeError(`Same-SHA baseline must be a distinct attempt: both are ${currentAttempt}`);
  }
  if (!Array.isArray(baseline.inputs) || !Array.isArray(receipt.inputs)) {
    throw new TypeError("Same-SHA comparison requires both receipts to declare their source-input manifest");
  }
  if (baseline.inputs_stable !== true || receipt.inputs_stable !== true) {
    throw new TypeError("Same-SHA comparison requires both receipts to observe stable source inputs");
  }
  if (baseline.run_attempts_required !== receipt.run_attempts_required) {
    throw new TypeError("Same-SHA baseline declares a different required attempt count");
  }
  if (JSON.stringify(baseline.inputs) !== JSON.stringify(receipt.inputs)) {
    throw new RangeError("Same-SHA baseline observed a different source-input manifest");
  }
  return { baseline_attempt: baseline.run_attempt, current_attempt: currentAttempt, manifest_entries: receipt.inputs.length };
}

/** A declared field must exist on every compared row; a silently absent field is a harness defect, not a match. */
function requireDeterminismFields(row, story, width) {
  const missing = DETERMINISM_FIELDS.filter(field => !Object.hasOwn(row ?? {}, field));
  if (missing.length) throw new RangeError(`Observation is missing declared determinism fields (${missing.join(", ")}) for ${story} at ${width}`);
}

/**
 * Compare two observation rows field by field with no tolerance-based auto-acceptance.
 *
 * `requireFields` is used for same-SHA determinism, where a missing field means the harness failed to observe
 * something it declared and must fail closed rather than treat two undefined values as equal.
 */
export function compareDeterministicObservations(first, second, { requireFields = false } = {}) {
  if (!Array.isArray(first) || !Array.isArray(second)) throw new TypeError("Determinism comparison requires two observation arrays");
  if (first.length !== second.length) throw new RangeError(`Determinism comparison requires equal case counts: ${first.length} vs ${second.length}`);
  const changed = [];
  for (const [index, left] of first.entries()) {
    const right = second[index];
    if (left.width !== right.width || left.story !== right.story) throw new RangeError("Determinism comparison requires matching width/story order");
    if (requireFields) {
      requireDeterminismFields(left, left.story, left.width);
      requireDeterminismFields(right, right.story, right.width);
    }
    for (const field of DETERMINISM_FIELDS) {
      let a = left[field], b = right[field];
      if (field === "focus") { const none = value => value === "NOT_APPLICABLE" ? null : value; a = none(a); b = none(b); }
      if (JSON.stringify(a) !== JSON.stringify(b)) changed.push({ width: left.width, story: left.story, field, previous: a, current: b });
    }
  }
  return { deterministic: changed.length === 0, changed };
}

