// C2-I owner-client move of packages/pwa-source-workspace/src/bundle-input.ts.
// Value and validation implementation moves here verbatim; only the byte-reading seam is
// injected. No new limit, path, manifest field or bundle rule is introduced.
import { NormalizedBundleManifestSchema, type NormalizedBundleManifest } from "@eliotr/contracts";
import type { LegacyErrorFactory } from "../../legacy/http.js";

export const BROWSER_BUNDLE_LIMITS = { files: 64, total_bytes: 32 * 1024 * 1024,
  file_bytes: 16 * 1024 * 1024, metadata_bytes: 256 * 1024 } as const;

/** Byte supplier; no ambient Blob, File or crypto access. */
export interface BundleBytePort {
  readonly digest: (bytes: Uint8Array) => Promise<string>;
  readonly readText: (bytes: Uint8Array) => string | undefined;
}

export interface BundleFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface BrowserBundle {
  readonly manifest: NormalizedBundleManifest;
  readonly files: readonly BundleFile[];
  readonly hashes: Readonly<Record<string, string>>;
  readonly totalBytes: number;
}

export type BundleInputErrors = LegacyErrorFactory;

export interface BundleInputApi {
  readonly safeBundlePath: (path: string) => string;
  readonly prepareBrowserBundle: (input: readonly BundleFile[], signal?: AbortSignal) =>
    Promise<BrowserBundle>;
}

export function createBundleInputApi(bytes: BundleBytePort, errors: BundleInputErrors):
  BundleInputApi {
  const inputError: (message: string) => never = (message) => {
    throw errors({ status: 400, code: "BUNDLE_INPUT_INVALID", message, traceId: null,
      retryable: false });
  };
  const checkCancelled = (signal?: AbortSignal): void => {
    if (signal?.aborted) {
      inputError("Import stopped. Already sent operations may have completed; inspect durable status.");
    }
  };
  const safeBundlePath = (path: string): string => {
    if (path.length > 512 || !path.split("/").every((part) =>
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(part))) {
      inputError("Use bounded relative bundle paths; traversal and duplicate separators are forbidden.");
    }
    return path;
  };
  const prepareBrowserBundle = async (input: readonly BundleFile[], signal?: AbortSignal):
    Promise<BrowserBundle> => {
    checkCancelled(signal);
    if (input.length < 3 || input.length > BROWSER_BUNDLE_LIMITS.files) {
      inputError("Select 3-64 bundle files.");
    }
    const names = new Set<string>();
    let totalBytes = 0;
    for (const file of input) {
      safeBundlePath(file.path);
      if (names.has(file.path)) inputError("The bundle contains a duplicate path.");
      names.add(file.path);
      const limit = ["manifest.json", "hashes.sha256"].includes(file.path)
        ? BROWSER_BUNDLE_LIMITS.metadata_bytes : BROWSER_BUNDLE_LIMITS.file_bytes;
      if (!Number.isSafeInteger(file.bytes.byteLength) || file.bytes.byteLength < 1 ||
          file.bytes.byteLength > limit) {
        inputError("A selected file is empty or exceeds the browser import profile (16 MiB/file; 256 KiB metadata).");
      }
      totalBytes += file.bytes.byteLength;
      if (totalBytes > BROWSER_BUNDLE_LIMITS.total_bytes) {
        inputError("Browser imports are limited to 32 MiB total.");
      }
    }
    for (const name of ["manifest.json", "content.md", "hashes.sha256"]) {
      if (!names.has(name)) {
        inputError("The folder must include manifest.json, content.md and hashes.sha256.");
      }
    }
    const files: BundleFile[] = [];
    const hashes: Record<string, string> = {};
    for (const file of input) {
      checkCancelled(signal);
      hashes[file.path] = await bytes.digest(file.bytes);
      files.push({ path: file.path, bytes: file.bytes });
    }
    checkCancelled(signal);
    const find = (path: string): BundleFile | undefined =>
      files.find((candidate) => candidate.path === path);
    const manifestFile = find("manifest.json");
    const hashFile = find("hashes.sha256");
    if (!manifestFile || !hashFile) inputError("Required bundle metadata is missing.");
    const manifestText = bytes.readText(manifestFile.bytes);
    if (manifestText === undefined) inputError("Manifest and hash list must be valid UTF-8.");
    let manifest: NormalizedBundleManifest;
    try { manifest = NormalizedBundleManifestSchema.parse(JSON.parse(manifestText)); }
    catch { return inputError("manifest.json does not match the strict normalized-bundle contract."); }
    const declared = new Set(["content.md", "manifest.json", "hashes.sha256"]);
    for (const path of [manifest.content.structure, manifest.content.mappings,
      manifest.content.tables]) {
      if (path !== undefined) declared.add(safeBundlePath(path));
    }
    if ([...declared].some((path) => !names.has(path)) ||
        [...names].some((path) => !declared.has(path) && !path.startsWith("assets/"))) {
      inputError("Selected files differ from the manifest's declared artifacts.");
    }
    const hashText = bytes.readText(hashFile.bytes);
    if (hashText === undefined) inputError("Manifest and hash list must be valid UTF-8.");
    const listed = new Map<string, string>();
    for (const line of hashText.split(/\r?\n/u)) {
      if (!line) continue;
      const match = /^([a-f0-9]{64}) [ *](.+)$/u.exec(line);
      if (!match?.[1] || !match[2]) inputError("hashes.sha256 contains an invalid entry.");
      const path = safeBundlePath(match[2]);
      if (path === "hashes.sha256" || listed.has(path)) {
        inputError("The hash list contains a duplicate or self-reference.");
      }
      listed.set(path, match[1]);
    }
    if (listed.size !== files.length - 1 ||
        [...listed].some(([path, digest]) => hashes[path] !== digest) ||
        hashes["content.md"] !== manifest.content.markdown_sha256) {
      inputError("Bundle checksums do not match the selected bytes.");
    }
    checkCancelled(signal);
    return { manifest, files, hashes, totalBytes };
  };

  return { safeBundlePath, prepareBrowserBundle };
}
