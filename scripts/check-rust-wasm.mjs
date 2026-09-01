import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const wasmPath = new URL(
  "../target/wasm32-unknown-unknown/release/eliotr_kernel_wasm.wasm",
  import.meta.url,
);
const SELF_TEST_EXPORTS = Object.freeze([
  "eliotr_m1_verify_embedded_vectors_v1",
  "eliotr_m2_verify_embedded_canonical_body_vectors_v1",
  "eliotr_m2_verify_embedded_stable_id_vectors_v1",
  "eliotr_m2_verify_embedded_owner_cutover_canonical_vectors_v1",
  "eliotr_m2_verify_embedded_residency_key_vectors_v1",
]);
const MAX_COMPRESSED_BYTES = 128 * 1024;
const modeIndex = process.argv.indexOf("--mode");
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : undefined;
if (mode !== "default" && mode !== "self-test") {
  throw new Error("usage: node scripts/check-rust-wasm.mjs --mode <default|self-test>");
}

const bytes = await readFile(wasmPath);
const compressedBytes = gzipSync(bytes, { level: 9 }).byteLength;
if (compressedBytes > MAX_COMPRESSED_BYTES) {
  throw new Error(
    `Rust/Wasm kernel exceeds the compressed budget: ${compressedBytes} > ${MAX_COMPRESSED_BYTES}`,
  );
}

const module = new globalThis.WebAssembly.Module(bytes);
const imports = globalThis.WebAssembly.Module.imports(module);
if (imports.length !== 0) {
  throw new Error(
    `Rust/Wasm verification artifact must be self-contained; imports: ${JSON.stringify(imports)}`,
  );
}

const exports = globalThis.WebAssembly.Module.exports(module);
const kernelExports = exports.map(({ name }) => name).filter((name) => name.startsWith("eliotr_"));

if (mode === "default") {
  if (kernelExports.length !== 0) {
    throw new Error(
      `default Rust/Wasm exposed product-shaped ABI symbols: ${kernelExports.join(", ")}`,
    );
  }
  console.log(
    `Rust/Wasm default: PASS (${bytes.byteLength} raw bytes, ${compressedBytes} gzip bytes, zero imports).`,
  );
} else {
  const allowed = new Set(SELF_TEST_EXPORTS);
  const unexpected = kernelExports.filter((name) => !allowed.has(name));
  const missing = SELF_TEST_EXPORTS.filter((name) => !kernelExports.includes(name));
  if (unexpected.length !== 0 || missing.length !== 0) {
    throw new Error(
      `Rust/Wasm self-test export mismatch; missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`,
    );
  }

  const instance = await globalThis.WebAssembly.instantiate(module, {});
  for (const name of SELF_TEST_EXPORTS) {
    const selfTest = instance.exports[name];
    if (typeof selfTest !== "function") {
      throw new Error(`Rust/Wasm self-test export is not callable: ${name}`);
    }
    if (selfTest() !== 1) {
      throw new Error(`Rust/Wasm rejected its exact embedded corpus: ${name}`);
    }
  }

  console.log(
    `Rust/Wasm self-test: PASS (${bytes.byteLength} raw bytes, ${compressedBytes} gzip bytes, ${SELF_TEST_EXPORTS.length} exact verification exports, zero imports).`,
  );
}
