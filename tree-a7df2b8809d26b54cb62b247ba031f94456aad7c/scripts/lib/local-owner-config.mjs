import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { localPaths, validateLocalVars } from "./local-launch.mjs";

export function validateOwnerConfig(value) {
  const keys = ["app", "team", "audience"];
  if (!value || typeof value !== "object" || Object.keys(value).length !== 3 ||
      keys.some((key) => typeof value[key] !== "string")) throw new Error("Owner settings require exactly app, team and audience");
  const origin = (text) => {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.origin !== text || !url.hostname.includes(".") ||
        url.hostname.length > 253 || !url.hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) ||
        /^[\d.]+$/u.test(url.hostname) || url.port || url.username || url.password) throw new Error("Use an exact HTTPS application/team origin without a path or port");
    return url;
  };
  origin(value.app);
  const team = origin(value.team);
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/u.test(team.hostname) || team.hostname.startsWith("replace-me.")) {
    throw new Error("Use the real Cloudflare Access team origin");
  }
  if (!/^[A-Za-z0-9_-]{1,512}$/u.test(value.audience) || value.audience === "replace-me") throw new Error("Invalid Access application audience");
  return { app: value.app, team: value.team, audience: value.audience };
}

export async function loadOwnerConfig({ directory = localPaths().directory, prompt = process.stdin.isTTY } = {}) {
  const file = resolve(directory, "owner.json");
  let settings;
  try {
    if ((await stat(file)).size > 4096) throw new Error("Owner settings exceed 4096 bytes");
    const text = await readFile(file, "utf8");
    if (Buffer.byteLength(text) > 4096) throw new Error("Owner settings exceed 4096 bytes");
    let decoded;
    try { decoded = JSON.parse(text); } catch { throw new Error("Owner settings are not valid JSON"); }
    settings = validateOwnerConfig(decoded);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (!prompt) throw new Error("Run pnpm local:owner in an interactive terminal once to configure Access", { cause: error });
    const io = createInterface({ input: process.stdin, output: process.stdout });
    try {
      settings = validateOwnerConfig({ app: (await io.question("Access application origin (https://research.example.com): ")).trim(),
        team: (await io.question("Access team origin (https://TEAM.cloudflareaccess.com): ")).trim(),
        audience: (await io.question("Access application AUD tag: ")).trim() });
    } finally { io.close(); }
    await mkdir(directory, { recursive: true });
    await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  const varsPath = resolve(directory, ".dev.vars");
  let original = "";
  try { await validateLocalVars(varsPath); original = await readFile(varsPath, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const vars = new Map(original.split(/\r?\n/u).map((line) => /^([A-Z_]+)="([^"\r\n]*)"$/u.exec(line.trim()))
    .filter(Boolean).map((match) => [match[1], match[2]]));
  for (const [key, value] of [["ACCESS_TEAM_DOMAIN", settings.team], ["ACCESS_AUDIENCE", settings.audience]]) {
    const placeholder = key === "ACCESS_TEAM_DOMAIN" ? "https://replace-me.cloudflareaccess.com" : "replace-me";
    if (vars.has(key) && vars.get(key) !== value && vars.get(key) !== placeholder) {
      throw new Error("Owner settings disagree with existing local Access configuration; reconcile them explicitly");
    }
    vars.set(key, value);
  }
  vars.set("ACCESS_SERVICE_PRINCIPALS", vars.get("ACCESS_SERVICE_PRINCIPALS") ?? "");
  const temp = `${varsPath}.${process.pid}.tmp`;
  await writeFile(temp, [...vars].map(([key, value]) => `${key}="${value}"\n`).join(""), { mode: 0o600 });
  await rename(temp, varsPath);
  return settings;
}
