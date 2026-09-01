import {
  ContractSchemaIndexEntrySchema,
  type ContractCompatibilityEntry,
  type ContractCompatibilityRegistry,
  type ContractSchemaIndexEntry,
} from "./registry-contracts.js";

const EXACT_INDEX_FIELDS = [
  "schema_id",
  "export_name",
  "family",
  "schema_version",
  "schema_generation",
  "kind",
  "structural_strictness",
  "json_schema_sha256",
] as const;

function terminalEntries(
  registry: ContractCompatibilityRegistry,
): ReadonlyMap<string, readonly ContractCompatibilityEntry[]> {
  const supersededIds = new Set(
    registry.entries.flatMap((entry) =>
      entry.supersedes_schema_id === undefined
        ? []
        : [entry.supersedes_schema_id],
    ),
  );
  const byExport = new Map<string, ContractCompatibilityEntry[]>();

  for (const entry of registry.entries) {
    if (supersededIds.has(entry.schema_id)) continue;
    const terminals = byExport.get(entry.export_name) ?? [];
    terminals.push(entry);
    byExport.set(entry.export_name, terminals);
  }

  return byExport;
}

/**
 * Proves that the generated current index names every active terminal history entry and no retired one.
 *
 * @throws {Error} when the index is malformed, stale, incomplete, duplicated, or disagrees with
 * compatibility history.
 */
export function assertCurrentContractCompatibility(
  currentEntries: readonly unknown[],
  registry: ContractCompatibilityRegistry,
): void {
  const parsedCurrentEntries = currentEntries.map((entry) =>
    ContractSchemaIndexEntrySchema.parse(entry),
  );
  const currentByExport = new Map<string, ContractSchemaIndexEntry>();
  for (const current of parsedCurrentEntries) {
    if (currentByExport.has(current.export_name)) {
      throw new Error(
        `current schema index contains duplicate export ${current.export_name}`,
      );
    }
    currentByExport.set(current.export_name, current);
  }

  const terminalsByExport = terminalEntries(registry);
  for (const [exportName, terminals] of terminalsByExport) {
    if (terminals.length !== 1) {
      throw new Error(
        `${exportName} compatibility history has ${terminals.length} terminal generations`,
      );
    }
    const [terminal] = terminals;
    if (terminal === undefined) {
      throw new Error(`${exportName} compatibility history has no terminal generation`);
    }

    const current = currentByExport.get(exportName);
    if (terminal.compatibility === "RETIRED") {
      if (current !== undefined) {
        throw new Error(`${exportName} is retired but remains in the current index`);
      }
      continue;
    }
    if (current === undefined) {
      throw new Error(
        `${exportName} has an active terminal generation missing from the current index`,
      );
    }
    if (current.schema_id !== terminal.schema_id) {
      throw new Error(
        `${exportName} current index points to ${current.schema_id}, but terminal history is ${terminal.schema_id}`,
      );
    }

    for (const field of EXACT_INDEX_FIELDS) {
      if (current[field] !== terminal[field]) {
        throw new Error(
          `${exportName} current index disagrees with terminal history field ${field}`,
        );
      }
    }
  }

  for (const current of parsedCurrentEntries) {
    if (!terminalsByExport.has(current.export_name)) {
      throw new Error(
        `${current.export_name} exists in the current index without compatibility history`,
      );
    }
  }
}
