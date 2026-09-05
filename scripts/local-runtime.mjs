import { spawn } from "node:child_process";
import { devArguments, localEnvironment, prepareLocal, ROOT, signalLocalProcess } from "./lib/local-launch.mjs";

const [argument, ...extra] = process.argv.slice(2);
const command = new Map([["--prepare", "prepare"], ["--dev", "dev"], ["--smoke", "smoke"]]).get(argument);
if (!["prepare", "dev", "smoke"].includes(command) || extra.length > 0) {
  console.error("Usage: node scripts/local-runtime.mjs --prepare|--dev|--smoke");
  process.exitCode = 2;
} else {
  try {
    if (command === "smoke") {
      const { smokeLocal } = await import("./lib/local-smoke.mjs");
      console.log(JSON.stringify(await smokeLocal(), null, 2));
    } else {
      const paths = await prepareLocal();
      if (command === "dev") {
        const child = spawn(process.execPath, devArguments(paths), {
          cwd: ROOT, env: localEnvironment(), stdio: "inherit", shell: false,
        });
        const stop = () => signalLocalProcess(child);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        const code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code) => resolve(code ?? 1));
        });
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        process.exitCode = code;
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
