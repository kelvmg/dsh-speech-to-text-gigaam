/**
 * GigaAM speech-to-text provider for the DSH voice-input subsystem.
 *
 * The heavy lifting happens in a Python worker (`python/gigaam_stt.py`) that
 * runs Sber's GigaAM model on the Host CPU. This module bridges the
 * `speechToText` service to that worker: it serializes recordings, spawns the
 * interpreter, forwards cancellation, and returns
 * `{ text, audioSeconds, inferenceSeconds }` — the shape the voice API
 * validates.
 */

import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const IS_WINDOWS = process.platform === "win32";
const DEFAULT_DATA_ROOT = join(homedir(), ".dsh", "speech-to-text", "gigaam");
const DEFAULT_PYTHON = join(
  DEFAULT_DATA_ROOT,
  "venv",
  IS_WINDOWS ? "Scripts" : "bin",
  IS_WINDOWS ? "python.exe" : "python",
);
const DEFAULT_SCRIPT = join(PACKAGE_DIR, "python", "gigaam_stt.py");
const DEFAULT_MODELS = join(DEFAULT_DATA_ROOT, "models");
const DEFAULT_MODEL = "v3_e2e_rnnt";
const DEFAULT_PROVIDER_ID = "gigaam-local";
const DEFAULT_LANGUAGES = ["auto", "ru", "en"];
const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_CHUNK_SECONDS = 20;
const MIN_CHUNK_SECONDS = 3;
// GigaAM accepts at most 25 s per call; stay just below the limit.
const MAX_CHUNK_SECONDS = 24.5;
const MAX_CAPTURED_CHARS = 1_000_000;
const ERROR_TAIL_CHARS = 1_200;

export const name = "speech-to-text-gigaam";
export const inject = ["speechToText"];

function cancelled() {
  const error = new Error("Speech transcription cancelled");
  error.name = "AbortError";
  return error;
}

function tail(text, limit) {
  const value = String(text ?? "").trim();
  return value.length > limit ? value.slice(-limit) : value;
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Normalize the row config so every consumer sees absolute, valid paths. */
function resolveConfig(raw) {
  const dataRoot = raw.dataRoot ?? DEFAULT_DATA_ROOT;
  return {
    providerId: raw.providerId ?? DEFAULT_PROVIDER_ID,
    providerName: raw.providerName ?? "GigaAM v3 (CPU)",
    pythonPath:
      raw.pythonPath ??
      join(dataRoot, "venv", IS_WINDOWS ? "Scripts" : "bin", IS_WINDOWS ? "python.exe" : "python"),
    scriptPath: raw.scriptPath ?? DEFAULT_SCRIPT,
    downloadRoot: raw.downloadRoot ?? join(dataRoot, "models"),
    model: raw.model ?? DEFAULT_MODEL,
    device: raw.device ?? "cpu",
    maxChunkSeconds: clamp(
      positive(raw.maxChunkSeconds, DEFAULT_MAX_CHUNK_SECONDS),
      MIN_CHUNK_SECONDS,
      MAX_CHUNK_SECONDS,
    ),
    timeoutMs: positive(raw.timeoutMs, DEFAULT_TIMEOUT_MS),
    languages:
      Array.isArray(raw.languages) && raw.languages.length > 0
        ? raw.languages.map(String)
        : DEFAULT_LANGUAGES,
  };
}

/** GUI-launched apps inherit a minimal PATH; ffmpeg usually sits elsewhere. */
function toolPath() {
  const prefixes = IS_WINDOWS
    ? []
    : ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];
  return [...prefixes, process.env.PATH].filter(Boolean).join(delimiter);
}

class GigaamWorker {
  constructor(ctx, config) {
    this.ctx = ctx;
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
              `GigaAM worksetup error: cannot start ${command}: ${error instanceof Error ? error.message : String(error)}`,
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

export function apply(ctx, config) {
  const settings = resolveConfig(config ?? {});
  const worker = new GigaamWorker(ctx, settings);

  access(settings.pythonPath, 0).catch(() => {
    ctx.logger?.warn?.(
      "GigaAM interpreter is missing at %s; run dsh-gigaam/python/setup.sh",
      settings.pythonPath,
    );
  });

  ctx.effect(() => {
    const unregister = ctx.speechToText.register({
      info: {
        id: settings.providerId,
        name: settings.providerName,
        location: "host-local",
        languages: settings.languages,
        downloadSources: [],
        setupEstimate: {
          recommendedDiskBytes: 3_000_000_000,
          expectedMemoryBytes: 1_500_000_000,
          minimumMinutes: 1,
          maximumMinutes: 30,
        },
      },
      transcribe: async (input, signal) => await worker.transcribe(input, signal),
    });

    return async () => {
      const removing = unregister();
      await worker.dispose();
      await removing;
    };
  });
}
