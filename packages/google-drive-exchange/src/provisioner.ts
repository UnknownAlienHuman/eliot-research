import type { ExchangeGeneration } from "@eliotr/contracts";
import type { GoogleDrivePort } from "./port.js";

export interface ExchangeTemplate {
  readonly protocol_version: "eliotr.drive.exchange.v1";
  readonly folder_name: "Eliot Research Exchange";
  readonly spreadsheet_name: "ERC Exchange";
  readonly sheet_ids: Readonly<Record<"SYSTEM" | "CATALOG" | "REQUESTS" | "PAYLOAD_PARTS" | "RECEIPTS" | "RESULTS" | "DASHBOARD", number>>;
}

export interface ExchangeGenerationRepository {
  persistShadow(generation: ExchangeGeneration): Promise<void>;
  activateShadow(generationId: string, expectedActiveGenerationId?: string): Promise<void>;
  retire(generationId: string): Promise<void>;
}

export interface ExchangeProvisioner {
  provisionShadow(template: ExchangeTemplate): Promise<ExchangeGeneration>;
  runAppendImportReadbackFixture(generation: ExchangeGeneration): Promise<{ passed: boolean; receipt_ref?: string; reason_codes: readonly string[] }>;
  activate(generation: ExchangeGeneration, expectedActiveGenerationId?: string): Promise<void>;
}

export interface ExchangeProvisionerDependencies {
  readonly drive: GoogleDrivePort;
  readonly generations: ExchangeGenerationRepository;
}
