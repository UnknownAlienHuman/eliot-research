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

function channelStateLabel(state: ChannelReadiness["state"]): string {
  switch (state) {
    case "not_requested": return "Not requested";
    case "queued": return "Queued";
    case "running": return "Running";
    case "ready": return "Ready";
    case "degraded": return "Degraded";
    case "failed": return "Failed";
    case "stale": return "Stale";
    case "redacted": return "Redacted";
  }
}

function freshnessLabel(value: string): string {
  switch (value) {
    case "current_confirmed": return "confirmed current";
    case "observed_with_age": return "last observation has aged";
    case "gap_detected": return "a history gap was detected";
    default: return "freshness is unknown";
  }
}

function qualityLabel(value: LibraryReadinessView["quality_state"]): string {
  switch (value) {
    case "high_fidelity": return "High fidelity";
    case "standard": return "Standard";
    case "degraded": return "Degraded";
    case "unqualified": return "Not qualified";
  }
}

function currentnessSummary(currentness: LibraryReadinessView["currentness"]): string {
  if (currentness.verification === "VERIFIED") {
    const observation = currentness.value;
    return observation.observation_freshness === "current_confirmed"
      ? "Source confirmed current"
      : `Saved source observation · ${freshnessLabel(observation.observation_freshness)}`;
  }

  const unavailable = currentness.reason_codes.some((reason) => reason.endsWith("_UNAVAILABLE"));
  const label = unavailable ? "Currentness evidence unavailable" : "Currentness not verified";
  return `${label} · saved record: ${freshnessLabel(currentness.recorded_freshness)}`;
}

type DetailRow = readonly [label: string, value: string];

function renderDetailRows(rows: readonly DetailRow[]): string {
  return rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("");
}

function currentnessDetailRows(currentness: LibraryReadinessView["currentness"]): DetailRow[] {
  if (currentness.verification === "NOT_VERIFIED") {
    return [
      ["Currentness verification", currentness.verification],
      ["Recorded freshness", currentness.recorded_freshness],
      ["Currentness reasons", currentness.reason_codes.join(", ")],
    ];
  }
  const observation = currentness.value;
  return [
    ["Currentness verification", currentness.verification],
    ["Currentness source revision", observation.source_revision_ref],
    ["Currentness owner system", observation.owner_system_id],
    ["Currentness owner generation", observation.source_owner_generation],
    ["Currentness source view", observation.source_view_ref],
    ["Workspace view revision", observation.workspace_view_revision_ref ?? "Not recorded"],
    ["Currentness freshness", observation.observation_freshness],
    ["Currentness observed at", observation.observed_at],
    ["Currentness expires at", observation.expires_at ?? "Not recorded"],
    ["Currentness gap references", observation.gap_refs.length === 0 ? "None recorded" : observation.gap_refs.join(", ")],
  ];
}

function channelDetailRows(readiness: readonly ChannelReadiness[], name: (typeof ACTIVE_CHANNELS)[number]): DetailRow[] {
  const value = channel(readiness, name);
  const label = channelLabel(name);
  return [
    [`${label} channel`, value.channel],
    [`${label} state`, value.state],
    [`${label} source revision`, value.source_revision_ref],
    [`${label} observed at`, value.observed_at],
    [`${label} generation`, value.generation ?? "Not recorded"],
    [`${label} receipt`, value.receipt_ref ?? "Not recorded"],
    [`${label} reasons`, value.reason_codes.length === 0 ? "None recorded" : value.reason_codes.join(", ")],
  ];
}

export function renderLibraryReadiness(readiness: LibraryReadinessView): string {
  const channelRows = ACTIVE_CHANNELS.map((name) => {
    const value = channel(readiness.channels, name);
    const label = channelLabel(name);
    const state = channelStateLabel(value.state);
    return `<li class="readiness-channel" data-readiness-channel="${escapeHtml(value.channel)}" data-readiness-state="${escapeHtml(value.state)}"><span class="readiness-channel-label">${escapeHtml(label)}</span><strong class="readiness-channel-state">${escapeHtml(state)}</strong></li>`;
  }).join("");
  const details: DetailRow[] = [
    ["Protocol", readiness.protocol],
    ["Source ID", readiness.source_id],
    ["Source revision", readiness.source_revision_ref],
    ["Quality state", readiness.quality_state],
    ["Readiness basis", readiness.readiness_basis],
    ["Readiness observed at", readiness.observed_at],
    ["Deployment generation", readiness.deployment_generation],
    ["Catalog generation", readiness.catalog_generation],
    ...currentnessDetailRows(readiness.currentness),
    ...ACTIVE_CHANNELS.flatMap((name) => channelDetailRows(readiness.channels, name)),
  ];

  return `<section class="readiness-card" aria-label="Active search readiness">
    <div class="readiness-summary">
      <p class="readiness-quality"><span>Quality</span><strong>${escapeHtml(qualityLabel(readiness.quality_state))}</strong></p>
      <p class="readiness-currentness"><span>Currentness</span><strong>${escapeHtml(currentnessSummary(readiness.currentness))}</strong></p>
    </div>
    <ul class="readiness-channels" aria-label="Search channels">${channelRows}</ul>
    <details class="readiness-details"><summary>Readiness details</summary><dl class="readiness-detail-list">${renderDetailRows(details)}</dl></details>
  </section>`;
}
