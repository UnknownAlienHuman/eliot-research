import {
  researchModelAccountAccessLabel,
  researchModelBillingLabel,
  researchModelCapabilityLabel,
  researchModelCatalogQualificationLabel,
  researchModelCatalogAdapterForRouteProvider,
  WORKERS_AI_CATALOG_ADAPTER_ID,
  researchModelSelectionApiLabel,
  researchModelSelectionBillingLabel,
  researchModelSelectionEffortLabel,
  researchModelSelectionEffectiveEffortLabel,
  type ResearchModelCatalogEntry,
  type ResearchModelConfigurationRevision,
  type ResearchModelSelectionSummary,
} from "./research-model-configuration-api.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function effortCapabilityNote(entry: ResearchModelCatalogEntry): string | undefined {
  const property = entry.properties.find((item) => item.property_id === "reasoning_effort");
  if (!property || !isRecord(property.value)) return undefined;
  const supported = property.value.supported_efforts;
  const efforts = Array.isArray(supported) && supported.every((item) =>
    item === "low" || item === "medium" || item === "high" || item === "max")
    ? supported as readonly string[] : undefined;
  const notes = efforts === undefined ? [] : [`Catalog-declared reasoning efforts: ${efforts.join(", ")}`];
  const normalized = property.value.normalizes_to;
  if (isRecord(normalized)) {
    for (const key of ["none", "low", "medium", "high", "xhigh", "max"]) {
      const value = normalized[key];
      if ((key === "none" || key === "xhigh") && (value === "low" || value === "medium" || value === "high" || value === "max")) {
        notes.push(`Catalog says ${key} resolves to ${value}.`);
      }
    }
  }
  return notes.length === 0 ? undefined : notes.join(" ");
}

function appendLine(parent: HTMLElement, label: string, value: string): void {
  const line = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = `${label}: `;
  line.append(strong, document.createTextNode(value));
  parent.append(line);
}

function renderModelSelection(selection: ResearchModelSelectionSummary): HTMLElement {
  const article = document.createElement("article");
  article.className = "connection-details-content";
  const heading = document.createElement("h4");
  heading.textContent = `${selection.stage} · ${selection.provider_id}/${selection.model_id}`;
  article.append(heading);
  appendLine(article, "Provider API", researchModelSelectionApiLabel(selection.transport_policy));
  appendLine(article, "Configured billing path", researchModelSelectionBillingLabel(selection.transport_policy));
  appendLine(article, "Output token field", selection.transport_policy.capabilities.max_output_tokens_field);
  appendLine(article, "Reasoning capabilities", researchModelSelectionEffortLabel(selection.transport_policy));
  appendLine(article, "Effective reasoning effort", researchModelSelectionEffectiveEffortLabel(selection));
  const refs = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Exact route and qualification identities";
  const detail = document.createElement("div");
  appendLine(detail, "Route", `${selection.route_ref} · ${selection.route_version}`);
  appendLine(detail, "Candidate", `${selection.candidate_ref} · SHA-256 ${selection.candidate_sha256}`);
  appendLine(detail, "Qualification", `${selection.qualification_ref} · SHA-256 ${selection.qualification_sha256}`);
  refs.append(summary, detail);
  article.append(refs);
  return article;
}

export function renderResearchModelConfigurationRevision(revision: ResearchModelConfigurationRevision): HTMLElement {
  const article = document.createElement("article");
  article.className = "connection-details-content";
  const heading = document.createElement("h4");
  heading.textContent = `${revision.configuration_ref} · ${revision.created_at} · ${researchModelConfigurationQualificationLabel(revision)}`;
  article.append(heading);
  const note = document.createElement("p");
  note.textContent = revision.qualification_state === "qualified"
    ? "Saved exact configuration is eligible under its saved rules. The server rechecks this choice before a new run. This view does not test provider credentials or invoke a model."
    : "The server could not validate this saved configuration under its saved rules, so it cannot be selected. Save another configuration that passes the required checks.";
  article.append(note);
  appendLine(article, "Configuration digest", revision.configuration_sha256);
  appendLine(article, "Semantic revision", `${revision.semantic_revision.revision_ref} · SHA-256 ${revision.semantic_revision.config_sha256}`);
  for (const selection of revision.model_selections) article.append(renderModelSelection(selection));
  return article;
}

export function renderResearchModelCatalogEntry(
  entry: ResearchModelCatalogEntry,
  revisions: readonly ResearchModelConfigurationRevision[],
  selectRevision: (revision: ResearchModelConfigurationRevision) => void,
): HTMLElement {
  const article = document.createElement("article");
  article.className = "connection-details-content";
  const heading = document.createElement("h4");
  heading.textContent = `${entry.name} · ${entry.model_id}`;
  article.append(heading);
  if (entry.description) {
    const description = document.createElement("p");
    description.textContent = entry.description;
    article.append(description);
  }
  appendLine(article, "Provider", entry.provider_id);
  appendLine(article, "Catalog", "Listed");
  appendLine(article, "Account", researchModelAccountAccessLabel(entry.account_availability));
  appendLine(article, "Capability", researchModelCapabilityLabel(entry.capabilities.text_generation));
  appendLine(article, "Schema capability", entry.capabilities.input_output_schema === "not_exposed_by_workers_ai_binding"
    ? `Not exposed by Workers AI binding; separate schema endpoint: ${entry.capabilities.schema_requirement ?? "unavailable"}`
    : entry.capabilities.input_output_schema);
  appendLine(article, "Billing", researchModelBillingLabel(entry));
  const effort = effortCapabilityNote(entry);
  if (effort) appendLine(article, "Effort metadata", effort);
  const qualification = document.createElement("p");
  qualification.textContent = researchModelCatalogQualificationLabel();
  article.append(qualification);
  const prepared = revisions.filter((revision) => researchModelConfigurationMatchesCatalog(revision, entry) &&
    researchModelConfigurationIsSelectable(revision));
  const stale = revisions.some((revision) => researchModelConfigurationMatchesCatalog(revision, entry) &&
    !researchModelConfigurationIsSelectable(revision));
  if (prepared.length === 0) {
    const blocked = document.createElement("p");
    blocked.textContent = stale
      ? "A saved configuration matches this catalog item, but the server could not validate its exact configuration. It remains in history and cannot be selected."
      : "No saved exact qualified project configuration matches this catalog item. It cannot be selected directly.";
    article.append(blocked);
  } else {
    const label = document.createElement("p");
    label.textContent = "This model appears in a saved exact project configuration:";
    article.append(label);
    for (const revision of prepared) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button button--quiet";
      button.dataset.modelPreparedConfiguration = "true";
      button.textContent = `Select saved configuration · ${researchModelConfigurationRevisionLabel(revision)}`;
      button.addEventListener("click", () => selectRevision(revision));
      article.append(button);
    }
  }
  return article;
}

export function researchModelConfigurationRevisionLabel(revision: ResearchModelConfigurationRevision): string {
  const identities = revision.model_selections.map((selection) => {
    const billing = selection.transport_policy.billing.mode === "unified" ? "configured unified billing" :
      `configured BYOK alias ${selection.transport_policy.billing.alias}`;
    const effort = selection.effective_reasoning_effort === null ? "effective effort unspecified" :
      `effective effort ${selection.effective_reasoning_effort}`;
    return `${selection.provider_id}/${selection.model_id} (${selection.stage}; ${billing}; ${selection.transport_policy.api}; ${effort})`;
  });
  return `${identities.join(" · ")} · ${revision.configuration_ref} · ${researchModelConfigurationQualificationLabel(revision)}`;
}

export function researchModelConfigurationIsSelectable(revision: ResearchModelConfigurationRevision): boolean {
  return revision.qualification_state === "qualified";
}

export function researchModelConfigurationQualificationLabel(revision: ResearchModelConfigurationRevision): string {
  return revision.qualification_state === "qualified" ? "Eligible for selection" : "Not selectable: qualification required";
}

export function researchModelConfigurationMatchesCatalog(
  revision: ResearchModelConfigurationRevision,
  entry: ResearchModelCatalogEntry,
): boolean {
  return revision.model_selections.some((selection) =>
    researchModelCatalogAdapterForRouteProvider(selection.provider_id) === entry.provider_id &&
    selection.model_id === entry.model_id);
}

export function researchModelCatalogProviderOptions(routeProviderIds: readonly string[]): readonly string[] {
  return Object.freeze([...new Set([WORKERS_AI_CATALOG_ADAPTER_ID,
    ...routeProviderIds.map(researchModelCatalogAdapterForRouteProvider),
  ])].sort((left, right) => left.localeCompare(right)));
}
