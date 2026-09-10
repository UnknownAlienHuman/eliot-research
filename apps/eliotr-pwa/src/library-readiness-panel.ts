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

export function renderLibraryReadiness(readiness: LibraryReadinessView): string {
  const currentness = readiness.currentness.verification === "VERIFIED"
    ? `<strong>Current source verified</strong> · ${escapeHtml(readiness.currentness.value.observation_freshness)}`
    : `<strong>Current source check unavailable</strong> · recorded freshness ${escapeHtml(readiness.currentness.recorded_freshness)}
       <span class="readiness-reasons">${readiness.currentness.reason_codes.map(escapeHtml).join(", ")}</span>`;
  return `<section class="readiness-card" aria-label="Active search readiness">
    <p><strong>Search readiness</strong> · ${escapeHtml(readiness.quality_state)} · observed ${escapeHtml(readiness.observed_at)}</p>
    <p>${currentness}</p>
    <dl>${ACTIVE_CHANNELS.map((name) => {
      const value = channel(readiness.channels, name);
      const state = value.state === "ready" ? "Ready" : value.state === "degraded" ? "Unavailable" : escapeHtml(value.state);
      return `<dt>${escapeHtml(channelLabel(name))}</dt><dd><strong>${state}</strong><br><small>${channelDetails(value)}</small></dd>`;
    }).join("")}</dl>
    <p class="readiness-fence">Head <code>${escapeHtml(readiness.source_revision_ref)}</code> · deployment <code>${escapeHtml(readiness.deployment_generation)}</code> · catalog observation <code>${escapeHtml(readiness.catalog_generation)}</code></p>
  </section>`;
}
