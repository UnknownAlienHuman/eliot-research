import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const pureCrates = [
  "crates/eliotr-canonical",
  "crates/eliotr-test-vectors",
];
const adapterCrate = "crates/eliotr-kernel-wasm";

const forbiddenManifestDependencies = [
  "getrandom",
  "js-sys",
  "rand",
  "reqwest",
  "tokio",
  "wasm-bindgen",
  "web-sys",
  "worker",
  "worker-sys",
];

const forbiddenSourcePatterns = [
  ["filesystem", /\bstd::fs\b/u],
  ["network", /\bstd::net\b/u],
  ["environment", /\bstd::env\b/u],
  ["process", /\bstd::process\b/u],
  ["system clock", /\b(?:SystemTime|Instant)::now\b/u],
  ["thread", /\bstd::thread\b/u],
  ["Cloudflare runtime", /\b(?:worker|worker_sys)::/u],
  ["browser runtime", /\b(?:web_sys|js_sys)::/u],
  ["randomness", /\b(?:rand|getrandom)::/u],
];

async function rustFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await rustFiles(path));
    else if (extname(entry.name) === ".rs") files.push(path);
  }
  return files;
}

function sourceViolations(source) {
  return forbiddenSourcePatterns
    .filter(([_name, pattern]) => pattern.test(source))
    .map(([name]) => name);
}

function manifestViolations(source) {
  return forbiddenManifestDependencies.filter((name) => {
    const dependency = new RegExp(`^\\s*${name}\\s*=`, "mu");
    return dependency.test(source);
  });
}

const errors = [];
for (const crate of pureCrates) {
  const absolute = join(root, crate);
  const manifest = await readFile(join(absolute, "Cargo.toml"), "utf8");
  for (const dependency of manifestViolations(manifest)) {
    errors.push(`${crate}/Cargo.toml declares forbidden dependency ${dependency}`);
  }

  const files = await rustFiles(join(absolute, "src"));
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (!source.includes("#![forbid(unsafe_code)]")) {
      errors.push(`${relative(root, file)} does not forbid unsafe code`);
    }
    for (const capability of sourceViolations(source)) {
      errors.push(`${relative(root, file)} reaches forbidden pure-core capability ${capability}`);
    }
  }
}

const adapterManifest = await readFile(join(root, adapterCrate, "Cargo.toml"), "utf8");
for (const dependency of manifestViolations(adapterManifest)) {
  errors.push(`${adapterCrate}/Cargo.toml declares forbidden runtime dependency ${dependency}`);
}
for (const file of await rustFiles(join(root, adapterCrate, "src"))) {
  const source = await readFile(file, "utf8");
  if (/\bunsafe\s*\{/u.test(source)) {
    errors.push(`${relative(root, file)} contains an unsafe block`);
  }
}

if (!sourceViolations("use std::fs;").includes("filesystem")) {
  errors.push("boundary checker negative fixture did not detect filesystem authority");
}
if (!manifestViolations('reqwest = "1"').includes("reqwest")) {
  errors.push("boundary checker negative fixture did not detect a network dependency");
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Rust language boundaries: PASS (${pureCrates.length} pure crates; synthetic negatives PASS).`,
  );
}
