import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const environment = { ...process.env, HOST: process.env.HOST || "127.0.0.1" };
const entry = fileURLToPath(new URL("../.output/server/index.mjs", import.meta.url));
const child = spawn(process.execPath, [entry], { env: environment, stdio: "inherit" });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

const exit = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
if (exit.signal) process.kill(process.pid, exit.signal);
process.exitCode = exit.code ?? 1;
