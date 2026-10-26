export interface OwnerActor {
  type: "owner";
  id: string;
  email?: string;
  authentication: "access" | "local" | "service-token";
}

export interface MeResponse {
  actor: OwnerActor;
}

export interface Project {
  id: string;
  title: string;
  description: string;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Source {
  id: string;
  title: string;
  kind: "file" | "url" | "text";
  currentRevisionId: string | null;
  revisionId: string;
  readableState: "pending" | "readable" | "readable_with_warnings" | "needs_conversion" | "failed";
  originalFilename: string | null;
  originalSize: number;
  readableSize: number | null;
  blockCount: number | null;
  warningSummary: string | null;
  error: string | null;
  converter: string | null;
  conversionTokens: number | null;
  conversionCalls: number;
  conversionMs: number | null;
  createdAt: number;
}

export interface Revision extends Pick<Source, "converter" | "conversionTokens" | "conversionCalls" | "conversionMs" | "warningSummary" | "error"> {
  id: string;
  readableState: Source["readableState"];
  createdAt: number;
}

export interface ApiError {
  error: {
    code: "invalid" | "not_found" | "conflict" | "busy" | "unavailable" | "budget";
    message: string;
  };
}
