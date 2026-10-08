import type { AuthenticatedRequestContext, OwnerApi, RawNormalizedAdmissionRequest } from "@eliotr/interfaces";
import { createRawNormalizedAdmissionService as createCapability, RawNormalizedAdmissionError } from "@eliotr/cloudflare-raw-ingest";
import type { RawCaptureReceipt, RawNormalizedAdmissionBundlePort, RawNormalizedAdmissionRequestPorts } from "@eliotr/cloudflare-raw-ingest";
import { readRawMarkdownCandidate } from "@eliotr/cloudflare-markdown";

export { RawNormalizedAdmissionError } from "@eliotr/cloudflare-raw-ingest";

function requireOwner(context: AuthenticatedRequestContext): void {
  if (context.client_class !== "owner_pwa") {
    throw new RawNormalizedAdmissionError("RAW_NORMALIZED_OWNER_REQUIRED", 403, "raw normalized admission requires an owner session");
  }
}

type OwnerBundleMethods = Pick<OwnerApi, "prepareBundle" | "uploadBundlePart" | "completeBundleFile" | "commitBundle" | "getBundleStatus" | "getBundleRecovery">;

function ownerPort(owner: OwnerBundleMethods, context: AuthenticatedRequestContext): RawNormalizedAdmissionBundlePort {
  return {
    getBundleRecovery: (operationId) => owner.getBundleRecovery(context, operationId),
    prepareBundle: (request) => owner.prepareBundle(context, request),
    uploadBundlePart: (request) => owner.uploadBundlePart(context, request),
    completeBundleFile: (request) => owner.completeBundleFile(context, request),
    commitBundle: (request) => owner.commitBundle(context, request),
    getBundleStatus: (operationId) => owner.getBundleStatus(context, operationId),
  };
}

/** Core retains session authentication and adapts it to the context-free ingest capability. */
export function createRawNormalizedAdmissionService(input: {
  readonly database: D1Database;
  readonly bucket: R2Bucket;
  readonly owner: OwnerBundleMethods;
  readonly readCapture: (context: AuthenticatedRequestContext, captureId: string) => Promise<RawCaptureReceipt | null>;
  readonly now?: () => number;
}) {
  const capability = createCapability({ database: input.database, ...(input.now === undefined ? {} : { now: input.now }) });
  function ports(context: AuthenticatedRequestContext): RawNormalizedAdmissionRequestPorts {
    return {
      owner: ownerPort(input.owner, context),
      readCapture: (captureId) => input.readCapture(context, captureId),
      async readConversion(capture, conversionOperationId, assertCurrent, signal) {
        const candidate = await readRawMarkdownCandidate(
          input.database,
          input.bucket,
          { principal_ref: context.principal_ref },
          capture,
          conversionOperationId,
          { assertCurrent, signal },
        );
        if (candidate === null) return null;
        const conversion = candidate.conversion;
        return {
          conversion: {
            protocol: conversion.protocol,
            state: "COMPLETE",
            operation_id: conversion.operation_id,
            capture_id: conversion.capture_id,
            content_sha256: conversion.content_sha256,
            output_sha256: conversion.output_sha256,
            output_bytes: conversion.output_bytes,
            detected_mime: conversion.detected_mime,
            format: conversion.format,
            tokens: conversion.tokens,
          },
          output: candidate.output,
        };
      },
    };
  }
  function actor(context: AuthenticatedRequestContext) {
    return { principal_ref: context.principal_ref, signal: context.request.signal };
  }
  return {
    admit(context: AuthenticatedRequestContext, captureId: string, request: RawNormalizedAdmissionRequest) {
      requireOwner(context);
      return capability.admit(actor(context), captureId, request, ports(context));
    },
    getStatus(context: AuthenticatedRequestContext, captureId: string, admissionOperationId: string) {
      requireOwner(context);
      return capability.getStatus(actor(context), captureId, admissionOperationId, ports(context));
    },
  };
}
