import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";

const wasmPath = new URL(
  "../target/wasm32-unknown-unknown/release/eliotr_kernel_wasm.wasm",
  import.meta.url,
);
const SELF_TEST_EXPORT = "eliotr_m1_verify_embedded_vectors_v1";
const MAX_COMPRESSED_BYTES = 128 * 1024;
const MODES = new Set(["default", "self-test"]);

function parseMode(arguments_) {
  const modeIndex = arguments_.indexOf("--mode");
  if (modeIndex < 0 || modeIndex + 1 >= arguments_.length) {
    throw new Error("usage: node scripts/check-rust-wasm.mjs --mode <default|self-test>");
  }
  const mode = arguments_[modeIndex + 1];
  if (!MODES.has(mode)) throw new Error(`unsupported Rust/Wasm verification mode: ${mode}`);
  return mode;
}

const mode = parseMode(process.argv.slice(2));
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
  throw new Error(`Rust/Wasm M1 artifact must be self-contained; imports: ${JSON.stringify(imports)}`);
}

const exports = globalThis.WebAssembly.Module.exports(module);
const eliotrExports = exports.map(({ name }) => name).filter((name) => name.startsWith("eliotr_"));

if (mode === "default") {
  if (eliotrExports.length > 0) {
    throw new Error(`default M1 artifact exposes premature product-shaped ABI: ${eliotrExports.join(", ")}`);
  }
} else {
  const unexpectedExports = eliotrExports.filter((name) => name !== SELF_TEST_EXPORT);
  if (unexpectedExports.length > 0) {
    throw new Error(`M1 self-test artifact exposes unexpected ABI symbols: ${unexpectedExports.join(", ")}`);
  }

  const instance = await globalThis.WebAssembly.instantiate(module, {});
  const selfTest = instance.exports[SELF_TEST_EXPORT];
  if (typeof selfTest !== "function") {
    throw new Error(`Rust/Wasm M1 self-test export is missing: ${SELF_TEST_EXPORT}`);
  }
  if (selfTest() !== 1) {
    throw new Error("Rust/Wasm did not accept the exact embedded conformance corpus");
  }
}

console.log(
  `Rust/Wasm ${mode}: PASS (${bytes.byteLength} raw bytes, ${compressedBytes} gzip bytes, zero imports).`,
);
