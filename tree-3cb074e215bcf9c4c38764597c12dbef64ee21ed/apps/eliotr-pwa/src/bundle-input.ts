import { NormalizedBundleManifestSchema, type NormalizedBundleManifest } from "@eliotr/contracts";
import { ApiRequestError } from "./api.js";

export const BROWSER_BUNDLE_LIMITS = { files: 64, total_bytes: 32 * 1024 * 1024,
  file_bytes: 16 * 1024 * 1024, metadata_bytes: 256 * 1024 } as const;
export interface BundleFile { readonly path: string; readonly blob: Blob; }
export interface BrowserBundle {
  readonly manifest: NormalizedBundleManifest;
  readonly files: readonly BundleFile[];
  readonly hashes: Readonly<Record<string, string>>;
  readonly totalBytes: number;
}
export function bundleInputError(message: string): never {
  throw new ApiRequestError({ status: 400, code: "BUNDLE_INPUT_INVALID", message });
}
export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ApiRequestError({ status: 499, code: "BUNDLE_IMPORT_CANCELLED",
    message: "Import stopped. Already sent operations may have completed; inspect durable status." });
}
export function safeBundlePath(path: string): string {
  if (path.length > 512 || !path.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(part))) {
    bundleInputError("Use bounded relative bundle paths; traversal and duplicate separators are forbidden.");
  }
  return path;
}
/** Only strip the common folder selected by the browser; never flatten nested artifact paths. */
export function selectedBundleFiles(files: readonly File[]): readonly BundleFile[] {
  const directory = files.some((file) => (file.webkitRelativePath ?? "") !== "");
  let root: string | undefined;
  return files.map((file) => {
    const relative = file.webkitRelativePath ?? "";
    if (!directory) return { path: safeBundlePath(file.name), blob: file };
    const separator = relative.indexOf("/");
    if (separator < 1) bundleInputError("Do not mix a folder selection with loose files.");
    const folder = relative.slice(0, separator);
    root ??= folder;
    if (root !== folder) bundleInputError("Select exactly one normalized bundle folder.");
    return { path: safeBundlePath(relative.slice(separator + 1)), blob: file };
  });
}
async function sha256(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function text(blob: Blob): Promise<string> {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(await blob.arrayBuffer()); }
  catch { return bundleInputError("Manifest and hash list must be valid UTF-8."); }
}
export async function prepareBrowserBundle(input: readonly BundleFile[], signal?: AbortSignal): Promise<BrowserBundle> {
  checkCancelled(signal);
  if (input.length < 3 || input.length > BROWSER_BUNDLE_LIMITS.files) bundleInputError("Select 3–64 bundle files.");
  const names = new Set<string>(); let totalBytes = 0;
  for (const file of input) {
    safeBundlePath(file.path);
    if (names.has(file.path)) bundleInputError("The bundle contains a duplicate path.");
    names.add(file.path);
    const limit = ["manifest.json", "hashes.sha256"].includes(file.path)
      ? BROWSER_BUNDLE_LIMITS.metadata_bytes : BROWSER_BUNDLE_LIMITS.file_bytes;
    if (!Number.isSafeInteger(file.blob.size) || file.blob.size < 1 || file.blob.size > limit) {
      bundleInputError("A selected file is empty or exceeds the browser import profile (16 MiB/file; 256 KiB metadata).");
    }
    totalBytes += file.blob.size;
    if (totalBytes > BROWSER_BUNDLE_LIMITS.total_bytes) bundleInputError("Browser imports are limited to 32 MiB total.");
  }
  for (const name of ["manifest.json", "content.md", "hashes.sha256"]) {
    if (!names.has(name)) bundleInputError("The folder must include manifest.json, content.md and hashes.sha256.");
  }
  // Snapshot validated bytes once. Uploads never reopen a potentially changed local file.
  const files: BundleFile[] = []; const hashes: Record<string, string> = {};
  for (const file of input) {
    checkCancelled(signal);
    const bytes = await file.blob.arrayBuffer();
    if (bytes.byteLength !== file.blob.size) bundleInputError("A selected file changed during reading.");
    hashes[file.path] = await sha256(bytes);
    files.push({ path: file.path, blob: new Blob([bytes]) });
  }
  checkCancelled(signal);
  const find = (path: string) => files.find((file) => file.path === path)?.blob;
  const manifestFile = find("manifest.json"); const hashFile = find("hashes.sha256");
  if (!manifestFile || !hashFile) bundleInputError("Required bundle metadata is missing.");
  let manifest: NormalizedBundleManifest;
  try { manifest = NormalizedBundleManifestSchema.parse(JSON.parse(await text(manifestFile))); }
  catch { return bundleInputError("manifest.json does not match the strict normalized-bundle contract."); }
  const declared = new Set(["content.md", "manifest.json", "hashes.sha256"]);
  for (const path of [manifest.content.structure, manifest.content.mappings, manifest.content.tables]) {
    if (path !== undefined) declared.add(safeBundlePath(path));
  }
  if ([...declared].some((path) => !names.has(path)) ||
      [...names].some((path) => !declared.has(path) && !path.startsWith("assets/"))) {
    bundleInputError("Selected files differ from the manifest's declared artifacts.");
  }
  const listed = new Map<string, string>();
  for (const line of (await text(hashFile)).split(/\r?\n/u)) {
    if (!line) continue;
    const match = /^([a-f0-9]{64}) [ *](.+)$/u.exec(line);
    if (!match?.[1] || !match[2]) bundleInputError("hashes.sha256 contains an invalid entry.");
    const path = safeBundlePath(match[2]);
    if (path === "hashes.sha256" || listed.has(path)) bundleInputError("The hash list contains a duplicate or self-reference.");
    listed.set(path, match[1]);
  }
  if (listed.size !== files.length - 1 || [...listed].some(([path, digest]) => hashes[path] !== digest) ||
      hashes["content.md"] !== manifest.content.markdown_sha256) bundleInputError("Bundle checksums do not match the selected bytes.");
  checkCancelled(signal);
  return { manifest, files, hashes, totalBytes };
}
