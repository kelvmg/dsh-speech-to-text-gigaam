import { spawn } from "node:child_process";

export function abortError() {
  const error = new Error("GigaAM operation cancelled");
  error.name = "AbortError";
  return error;
}

/** Reap the entire process group before resolving, cleaning files or starting another job. */
export function runProcess(command, args, { signal, timeoutMs = 900_000, env = process.env, onOutput, onSpawn, onFinish } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    let failure;
    let stdout = "";
    let stderr = "";
    let child;
    let timer;
    const stop = (error) => {
      failure ??= error;
      if (!child?.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") child.kill("SIGKILL");
      }
    };
    const onAbort = () => stop(abortError());
    try {
      child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"], env,
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    onSpawn?.(child);
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-16_000);
      onOutput?.(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16_000);
      onOutput?.(String(chunk));
    });
    child.on("error", (error) => { failure ??= error; });
    child.on("close", (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      onFinish?.(child);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${command} exited with ${code ?? exitSignal}: ${(stderr || stdout || "no output").trim().slice(-1600)}`));
      else resolve({ stdout, stderr });
    });
    timer = setTimeout(() => stop(new Error(`GigaAM operation timed out after ${timeoutMs} ms`)), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
