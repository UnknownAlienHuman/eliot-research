import type { AuthenticatedRequestContext, OwnerApi } from "@eliotr/interfaces";
import {
  dispatchIngestOperation as dispatchCapability,
  type NormalizedIngestOperationPort,
} from "@eliotr/cloudflare-raw-ingest";

export {
  IngestHttpInputError,
  rawNormalizedAdmissionRequest,
  prepareBundleRequest,
  discoverBundleRequest,
  completeBundleRequest,
  commitBundleRequest,
} from "@eliotr/cloudflare-raw-ingest";

/** Core adapter binds the authenticated owner request to the portable HTTP parser/dispatcher. */
export function dispatchIngestOperation(
  operation: string,
  request: Request,
  url: URL,
  params: Readonly<Record<string, string>>,
  maximumBytes: number,
  context: AuthenticatedRequestContext,
  owner: OwnerApi,
): Promise<unknown> {
  const operations: NormalizedIngestOperationPort = {
    admitRawFileToNormalized: (captureId, body) => owner.admitRawFileToNormalized(context, captureId, body),
    getRawNormalizedAdmissionStatus: (captureId, admissionId) => owner.getRawNormalizedAdmissionStatus(context, captureId, admissionId),
    prepareBundle: (body) => owner.prepareBundle(context, body),
    uploadBundlePart: (body) => owner.uploadBundlePart(context, body),
    completeBundleFile: (body) => owner.completeBundleFile(context, body),
    commitBundle: (body) => owner.commitBundle(context, body),
    discoverBundle: (body) => owner.discoverBundle(context, body),
    getBundleRecovery: (operationId) => owner.getBundleRecovery(context, operationId),
    getBundleStatus: (operationId) => owner.getBundleStatus(context, operationId),
  };
  return dispatchCapability(operation, request, url, params, maximumBytes, operations);
}
