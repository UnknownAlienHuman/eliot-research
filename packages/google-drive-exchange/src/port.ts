export interface DriveChangePage {
  readonly changes: readonly DriveChange[];
  readonly nextPageToken?: string;
  readonly newStartPageToken?: string;
}

export interface DriveChange {
  readonly fileId: string;
  readonly removed: boolean;
  readonly modifiedTime?: string;
}

export interface SheetRange {
  readonly range: string;
  readonly values: readonly (readonly unknown[])[];
}

export interface WriteReceipt {
  readonly spreadsheetId: string;
  readonly replies: readonly unknown[];
  /** Local HTTP acknowledgement observation time; not Google commit time or exact row readback. */
  readonly writtenAt: string;
}

export interface ResultDocumentInput {
  readonly title: string;
  readonly markdownObjectRef: string;
  readonly expectedArtifactRevision: number;
  readonly folderId: string;
}

export interface DriveObjectRef {
  readonly fileId: string;
  readonly webViewUrl: string;
  readonly modifiedTime: string;
}

export interface DriveFileMetadata extends DriveObjectRef {
  readonly name: string;
  readonly mimeType: string;
  readonly parents: readonly string[];
  readonly sha256Checksum?: string;
}

export interface GoogleDrivePort {
  getStartPageToken(): Promise<string>;
  listChanges(pageToken: string): Promise<DriveChangePage>;
  readSheetRanges(spreadsheetId: string, ranges: string[]): Promise<SheetRange[]>;
  batchUpdateSheet(spreadsheetId: string, requests: unknown[]): Promise<WriteReceipt>;
  createResultDocument(input: ResultDocumentInput): Promise<DriveObjectRef>;
  exportDocument(fileId: string, mimeType: string): Promise<ReadableStream<Uint8Array>>;
  getFileMetadata(fileId: string): Promise<DriveFileMetadata>;
}
