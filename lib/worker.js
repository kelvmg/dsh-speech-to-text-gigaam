/** Serialized, cancellable Python jobs. Audio is removed only after the child exits. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { toolPath } from "./config.js";
import { abortError, runProcess } from "./process.js";

export class GigaamWorker {
  constructor(config) {
    this.config = config;
    this.current = undefined;
    this.tail = Promise.resolve();
    this.closed = false;
    this.shutdown = new AbortController();
  }

  enqueue(operation, signal) {
    const combined = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    if (this.closed || combined.aborted) return Promise.reject(abortError());
    let started = false;
    const internal = this.tail.then(async () => {
      combined.throwIfAborted();
      if (this.closed) throw abortError();
      started = true;
      return await operation(combined);
    });
    this.tail = internal.catch(() => undefined);
    // A cancelled queued caller does not have to wait for the recording before it.
    // Once started, wait for process close AND file cleanup before settling.
    return new Promise((resolve, reject) => {
      const onAbort = () => { if (!started) reject(abortError()); };
      combined.addEventListener("abort", onAbort, { once: true });
      internal.then(resolve, reject).finally(() => combined.removeEventListener("abort", onAbort));
      if (combined.aborted) onAbort();
    });
  }

  transcribe(input, signal) {
    if (!input?.audio) return Promise.reject(new Error("GigaAM provider received no audio"));
    return this.enqueue((jobSignal) => this.run(input, jobSignal), signal);
  }

  async run(input, signal) {
    signal.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), "dsh-gigaam-"));
    const wavPath = join(directory, "audio.wav");
    const textPath = join(directory, "transcript.txt");
    try {
      await writeFile(wavPath, Buffer.from(input.audio), { mode: 0o600 });
      const args = [this.config.scriptPath, "--input", wavPath, "--output", textPath,
        "--model", this.config.model, "--device", this.config.device,
        "--max-chunk", String(this.config.maxChunkSeconds), "--download-root", this.config.downloadRoot];
      const startedAt = Date.now();
      await this.spawn(this.config.pythonPath, args, signal);
      const text = (await readFile(textPath, "utf8")).trim();
      signal.throwIfAborted();
      return { text, audioSeconds: Math.max(0, input.audio.byteLength - 44) / 32000,
        inferenceSeconds: (Date.now() - startedAt) / 1000 };
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }

  warmup(signal) {
    return this.enqueue((jobSignal) => this.spawn(this.config.pythonPath, [this.config.scriptPath,
      "--warmup", "--model", this.config.model, "--device", this.config.device,
      "--download-root", this.config.downloadRoot], jobSignal), signal);
  }

  async spawn(command, args, signal) {
    try {
      const processArgs = this.config.manageRuntime ? ["-I", ...args] : args;
      return await runProcess(command, processArgs, {
        signal, timeoutMs: this.config.timeoutMs,
        env: { ...process.env, PATH: [dirname(this.config.pythonPath), toolPath()].join(process.platform === "win32" ? ";" : ":"), PYTHONUNBUFFERED: "1", PYTHONNOUSERSITE: "1" },
        onSpawn: (child) => { this.current = child; },
        onFinish: (child) => { if (this.current === child) this.current = undefined; },
      });
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`GigaAM interpreter not found (${command}). Open voice settings and select Download and prepare.`);
      throw error;
    }
  }

  async dispose() {
    this.closed = true;
    this.shutdown.abort();
    await this.tail;
  }
}
