import { lstat, mkdir, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import console from "node:console";
import process from "node:process";

const scriptPath = await realpath(fileURLToPath(import.meta.url));
const root = resolve(dirname(scriptPath), "..");
const core = resolve(root, "apps/eliotr-core");
const stateDirectory = resolve(root, ".eliotr-state");
const generatedDirectory = resolve(stateDirectory, "generated-types");
const outputFile = resolve(generatedDirectory, "eliotr-core.d.ts");

function isContained(parent, candidate) {
  const relativePath = relative(parent, candidate);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath));
}

function samePath(left, right) {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

async function ensureContainedDirectory(parent, directory, label) {
  if (!isContained(parent, directory) || dirname(directory) !== parent) {
    throw new Error(`${label} directory escaped its fixed parent`);
  }
  try {
    await mkdir(directory);
  } catch (error) {
    if (error.code !== "EEXIST") throw new Error(`${label} directory could not be created`, { cause: error });
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} is not a regular directory`);
  const actual = await realpath(directory);
  if (!isContained(parent, actual) || !samePath(actual, directory)) {
    throw new Error(`${label} traverses a symlink or escapes its parent`);
  }
}

async function checkOutputFile(required) {
  let info;
  try {
    info = await lstat(outputFile);
  } catch (error) {
    if (!required && error.code === "ENOENT") return;
    throw new Error("Cloudflare type output is unavailable", { cause: error });
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Cloudflare type output is not a regular file");
  const actual = await realpath(outputFile);
  if (!isContained(generatedDirectory, actual) || !samePath(actual, outputFile)) {
    throw new Error("Cloudflare type output traverses a symlink or escapes its directory");
  }
}

async function main() {
  if (!isContained(root, core) || !isContained(root, stateDirectory)
    || !isContained(root, generatedDirectory) || !isContained(root, outputFile)) {
    throw new Error("Cloudflare type output path escaped the repository");
  }
  await ensureContainedDirectory(root, stateDirectory, ".eliotr-state");
  await ensureContainedDirectory(stateDirectory, generatedDirectory, "generated-types");
  await checkOutputFile(false);

  const outputArgument = relative(core, outputFile).split(sep).join("/");
  const result = spawnSync("pnpm", ["exec", "wrangler", "types", "--env-interface", "CloudflareEnv", outputArgument], {
    cwd: core,
    env: process.env,
    shell: process.platform === "win32",
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  if (result.error) throw new Error("Local pnpm/Wrangler type generation could not be started");
  if (result.status !== 0 || result.signal !== null) {
    process.exitCode = result.status ?? 1;
    return;
  }
  await checkOutputFile(true);
  console.log("CloudflareEnv declarations generated under .eliotr-state/generated-types.");
}

try {
  await main();
} catch (error) {
  console.error(`Cloudflare type generation failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
}
