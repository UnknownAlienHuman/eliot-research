// Test-only spawn gate: explicit per-spawn usage admission for child CLIs.
//
// Spawned provisioner/preflight children cannot receive JS options, and
// production no longer reads ambient fixture vars. Tests that must exercise
// real apply paths (lost-ACK, fail-before-write, mutation counts, drift)
// spawn the child with `node --import <this file> <script>`, which registers
// test-usage-gate-hooks.mjs. That hook substitutes
// lib/cloudflare-usage-collection.mjs and lib/cloudflare-usage-admission.mjs
// with test-usage-gate-standin.mjs, which honors
// ELIOTR_TEST_SPAWN_SNAPSHOT_JSON for that child only.
//
// Production modules never read ELIOTR_TEST_SPAWN_SNAPSHOT_JSON and never
// register this loader, so the variable alone (poisoned env without the
// --import flag) cannot admit: every suite asserts that denial explicitly.
// FIX9WC: the same holds for NODE_OPTIONS-only injection — the hooks refuse
// to redirect when ambient NODE_OPTIONS carries loader tokens, so spawn sites
// must pass --import via argv AND scrub loader tokens from the child env's
// NODE_OPTIONS (benign flags may stay). An unscrubbed poisoned outer env only
// degrades legitimate children to SEALED (fail-closed, never false-admit).
// No production-reachable test flag is added; this file is referenced solely
// by test spawn argv.
import { register } from "node:module";

register("./test-usage-gate-hooks.mjs", import.meta.url);
