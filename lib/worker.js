/**
 * Spawns the Python worker (`python/gigaam_stt.py`) for one recording at a
 * time and translates its results into the transcription envelope the voice
 * API expects.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toolPath } from "./config.js";

const MAX_CAPTURED_CHARS = 1_000_000;
const ERROR_TAIL_CHARS = 1_200;

function cancelled() {
  const error = new Error("Speech transcription cancelled");
  error.name = "AbortError";
  return error;
}

function tail(text, limit) {
  const value = String(text ?? "").trim();
  return value.length > limit ? value.slice(-limit) : value;
}

export class GigaamWorker {
  constructor(config) {
    this.config = config;
    this.current = undefined;
    this.tail = Promise.resolve();
    this.closed = false;
  }

  /** Queue one recording so a single Python model instance runs at a time. */
  transcribe(input, signal) {
    if (!input || !input.audio) {
      return Promise.reject(new Error("GigaAM provider received no audio"));
    }
    const job = this.tail.then(
      () => this.run(input, signal),
      () => this.run(input, signal),
    );
    this.tail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }

  async run(input, signal) {
    if (this.closed) throw cancelled();
    signal.throwIfAborted();

    const directory = await mkdtemp(join(tmpdir(), "dsh-gigaam-"));
    const wavPath = join(directory, "audio.wav");
    const textPath = join(directory, "transcript.txt");

    try {
      await writeFile(wavPath, Buffer.from(input.audio));
      const args = [
        this.config.scriptPath,
        "--input",
        wavPath,
        "--output",
        textPath,
        "--model",
        this.config.model,
        "--device",
        this.config.device,
        "--max-chunk",
        String(this.config.maxChunkSeconds),
      ];
      if (this.config.downloadRoot) {
        args.push("--download-root", this.config.downloadRoot);
      }

      const startedAt = Date.now();
      await this.spawn(this.config.pythonPath, args, signal);
      const text = (await readFile(textPath, "utf8")).trim();
      signal.throwIfAborted();

      return {
        text,
        audioSeconds: Math.max(0, input.audio.byteLength - 44) / 32000,
        inferenceSeconds: (Date.now() - startedAt) / 1000,
      };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Download/verify the configured model by loading it once. */
  async warmup(signal) {
    const args = [
      this.config.scriptPath,
      "--warmup",
      "--model",
      this.config.model,
      "--download-root",
      this.config.downloadRoot,
    ];
    await this.spawn(this.config.pythonPath, args, signal);
  }

  spawn(command, args, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(cancelled());
        return;
      }

      let settled = false;
      let child;
      let timer;
      const onAbort = () => {
        child?.kill("SIGKILL");
        settle(() => reject(cancelled()));
      };
      const settle = (action) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (this.current === child) this.current = undefined;
        action();
      };

      try {
        child = spawn(command, args, {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, PATH: toolPath(), PYTHONUNBUFFERED: "1" },
        });
      } catch (error) {
        settle(() =>
          reject(
            new Error(
              `GigaAM worker failed to start (${command}): ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        );
        return;
      }
      this.current = child;

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout = tail(stdout + String(chunk), MAX_CAPTURED_CHARS);
      });
      child.stderr?.on("data", (chunk) => {
        stderr = tail(stderr + String(chunk), MAX_CAPTURED_CHARS);
      });

      timer = setTimeout(() => {
        child.kill("SIGKILL");
        settle(() =>
          reject(
            new Error(
              `GigaAM timed out after ${this.config.timeoutMs} ms: ${tail(stderr, ERROR_TAIL_CHARS) || "no output"}`,
            ),
          ),
        );
      }, this.config.timeoutMs);

      signal.addEventListener("abort", onAbort, { once: true });

      child.on("error", (error) => {
        const hint =
          error && error.code === "ENOENT"
            ? ` — interpreter or script not found. Run python/setup.sh (expected ${command}).`
            : "";
        settle(() =>
          reject(
            new Error(
              `GigaAM worker failed to start${hint}: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        );
      });

      child.on("close", (code, exitSignal) => {
        if (signal.aborted) {
          settle(() => reject(cancelled()));
          return;
        }
        if (code === 0) {
          settle(() => resolve({ stdout, stderr }));
          return;
        }
        settle(() =>
          reject(
            new Error(
              `GigaAM worker exited with ${code ?? exitSignal}: ${
                tail(stderr, ERROR_TAIL_CHARS) || tail(stdout, ERROR_TAIL_CHARS) || "no output"
              }`,
            ),
          ),
        );
      });
    });
  }

  async dispose() {
    this.closed = true;
    this.current?.kill("SIGKILL");
    await this.tail;
  }
}
