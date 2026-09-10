import type { ChannelReadiness } from "@eliotr/contracts";
import { escapeHtml } from "./html.js";
import type { LibraryReadinessView } from "./library-readiness-api.js";

const ACTIVE_CHANNELS = ["exact_ready", "lexical_ready", "semantic_ready"] as const;

function channel(readiness: readonly ChannelReadiness[], name: (typeof ACTIVE_CHANNELS)[number]): ChannelReadiness {
  const value = readiness.find((item) => item.channel === name);
  if (!value) throw new Error(`missing active readiness channel ${name}`);
  return value;
}

function channelLabel(name: (typeof ACTIVE_CHANNELS)[number]): string {
  return name === "exact_ready" ? "Exact search" : name === "lexical_ready" ? "Lexical search" : "Semantic search";
}

function channelDetails(value: ChannelReadiness): string {
  const details = [
    value.generation ? `generation ${escapeHtml(value.generation)}` : "no active generation",
    value.receipt_ref ? `receipt ${escapeHtml(value.receipt_ref)}` : "no receipt",
  ];
  if (value.reason_codes.length) details.push(value.reason_codes.map(escapeHtml).join(", "));
  return details.join(" · ");
}

function freshnessLabel(value: string): string {
  switch (value) {
    case "current_confirmed": return "current at the last check";
    case "observed_with_age": return "last observation has aged";
    case "gap_detected": return "a history gap was detected";
    default: return "freshness is unknown";
  }
}

function qualityLabel(value: LibraryReadinessView["quality_state"]): string {
  return value === "high_fidelity" ? "high fidelity" : value === "unqualified" ? "not qualified" : value;
}

export function renderLibraryReadiness(readiness: LibraryReadinessView): string {
  const currentness = readiness.currentness.verification === "VERIFIED"
    ? `<strong>Source is current</strong> · observed ${escapeHtml(readiness.currentness.value.observed_at)}`
    : `<strong>Freshness not verified</strong> · ${escapeHtml(freshnessLabel(readiness.currentness.recorded_freshness))}
       <details><summary>Why</summary><small>Recorded freshness ${escapeHtml(readiness.currentness.recorded_freshness)} · ${readiness.currentness.reason_codes.map(escapeHtml).join(", ")}</small></details>`;
  return `<section class="readiness-card" aria-label="Active search readiness">
    <p><strong>Search readiness</strong> · ${escapeHtml(qualityLabel(readiness.quality_state))} · observed ${escapeHtml(readiness.observed_at)}</p>
    <p>${currentness}</p>
    <dl>${ACTIVE_CHANNELS.map((name) => {
      const value = channel(readiness.channels, name);
      const state = value.state === "ready" ? "Ready" : value.state === "degraded" ? "Unavailable" : escapeHtml(value.state);
      return `<dt>${escapeHtml(channelLabel(name))}</dt><dd><strong>${state}</strong><details><summary>Details</summary><small>${channelDetails(value)}</small></details></dd>`;
    }).join("")}</dl>
    <details class="readiness-fence"><summary>Technical details</summary><small>Head <code>${escapeHtml(readiness.source_revision_ref)}</code> · deployment <code>${escapeHtml(readiness.deployment_generation)}</code> · catalog observation <code>${escapeHtml(readiness.catalog_generation)}</code></small></details>
  </section>`;
}
