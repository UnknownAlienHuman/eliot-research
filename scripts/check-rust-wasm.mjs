import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";

const wasmPath = new URL(
  "../target/wasm32-unknown-unknown/release/eliotr_kernel_wasm.wasm",
  import.meta.url,
);
const SELF_TEST_EXPORT = "eliotr_m1_verify_embedded_vectors_v1";
const MAX_COMPRESSED_BYTES = 128 * 1024;

const bytes = await readFile(wasmPath);
const compressedBytes = gzipSync(bytes, { level: 9 }).byteLength;
if (compressedBytes > MAX_COMPRESSED_BYTES) {
  throw new Error(
    `Rust/Wasm kernel exceeds the M1 compressed budget: ${compressedBytes} > ${MAX_COMPRESSED_BYTES}`,
  );
}

const module = new globalThis.WebAssembly.Module(bytes);
const imports = globalThis.WebAssembly.Module.imports(module);
if (imports.length !== 0) {
  throw new Error(`Rust/Wasm M1 self-test must be self-contained; imports: ${JSON.stringify(imports)}`);
}

const exports = globalThis.WebAssembly.Module.exports(module);
const unexpectedProductExports = exports
  .map(({ name }) => name)
  .filter((name) => name.startsWith("eliotr_") && name !== SELF_TEST_EXPORT);
if (unexpectedProductExports.length > 0) {
  throw new Error(
    `M1 exposed product-shaped ABI symbols before M5: ${unexpectedProductExports.join(", ")}`,
  );
}

const instance = await globalThis.WebAssembly.instantiate(module, {});
const selfTest = instance.exports[SELF_TEST_EXPORT];
if (typeof selfTest !== "function") {
  throw new Error(`Rust/Wasm M1 self-test export is missing: ${SELF_TEST_EXPORT}`);
}
if (selfTest() !== 1) {
  throw new Error("Rust/Wasm did not accept the exact embedded conformance corpus");
}

console.log(
  `Rust/Wasm vectors: PASS (${bytes.byteLength} raw bytes, ${compressedBytes} gzip bytes, zero imports).`,
);
