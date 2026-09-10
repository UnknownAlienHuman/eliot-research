import type { ExchangeGeneration } from "@eliotr/contracts";
import type { DriveObjectRef, GoogleDrivePort } from "./port.js";

export interface ResultPublicationInput {
  readonly generation: ExchangeGeneration;
  readonly request_id: string;
  readonly artifact_ref: string;
  readonly artifact_revision: number;
  readonly artifact_sha256: string;
  readonly markdown_object_ref: string;
  readonly title: string;
  readonly completion_disposition: string;
}

export interface ResultPublicationReceipt {
  readonly document: DriveObjectRef;
  readonly results_row_readback_sha256: string;
  readonly canonical_artifact_ref: string;
  readonly drive_copy_is_canonical: false;
}

export interface DriveResultPublisher {
  publish(input: ResultPublicationInput): Promise<ResultPublicationReceipt>;
}

export interface DriveResultPublisherDependencies {
  readonly drive: GoogleDrivePort;
}
