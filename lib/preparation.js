/**
 * Host-owned preparation for the single supported GigaAM model.
 *
 * The provider never downloads on activation: `inspect()` only stats the
 * cache, so the voice UI can show an explicit "Download and prepare" card.
 * `prepare()` checks the Python environment, downloads the checkpoint and
 * tokenizer with progress, verifies their size and checksum, then loads the
 * model once so the first dictation does not pay for it.
 */

import { access, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { downloadVerified, verifyFile } from "./download.js";
import { RuntimeManager } from "./runtime.js";

import { catalogFor, fileUrl, SUPPORTED_MODEL } from "./config.js";

const KINDS = ["check", "model", "verify", "load"];

function steps({ running, failed, complete = [], cancelled = [] } = {}) {
  return KINDS.map((kind) => {
    const status =
      kind === failed
        ? "failed"
        : kind === running
          ? "running"
          : complete.includes(kind)
            ? "complete"
            : cancelled.includes(kind)
              ? "cancelled"
              : "pending";
    const step = { kind, status };
    if (status === "running") step.startedAt = Date.now();
    return step;
  });
}

function completedBefore(kind) {
  const index = KINDS.indexOf(kind);
  return index <= 0 ? [] : KINDS.slice(0, index);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function classify(error) {
  const code = error?.code ?? error?.cause?.code;
  if (code !== undefined) {
    if (/^(ENOTFOUND|EAI_AGAIN)$/.test(code)) return { reason: "dns", code };
    if (/^(ETIMEDOUT|ERR_SOCKET_CONNECTION_TIMEOUT)$/.test(code)) return { reason: "timeout", code };
    if (/^(CERT_|ERR_TLS|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/.test(code)) {
      return { reason: "certificate", code };
    }
    if (/^(ENOSPC|EDQUOT|EACCES|EPERM|EROFS)$/.test(code)) return { reason: "storage", code };
    if (/^(ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR_SOCKET)$/.test(code)) {
      return { reason: "network", code };
    }
  }
  if (error?.name === "TimeoutError") return { reason: "timeout" };
  if (error?.name === "TypeError" && /fetch failed/i.test(error.message ?? "")) {
    return { reason: "network" };
  }
  return { reason: "unknown" };
}

class PreparationFailure extends Error {
  constructor(message, step, download) {
    super(message);
    this.name = "PreparationFailure";
    this.step = step;
    this.download = download;
  }
}

export class Preparation {
  constructor(config, worker, runtime = new RuntimeManager(config)) {
    this.config = config;
    this.worker = worker;
    this.runtime = runtime;
    this.generation = 0;
    this.listeners = new Set();
    this.task = undefined;
    this.abort = undefined;
    this.closed = false;
    this.state = {
      phase: "checking",
      startedAt: Date.now(),
      step: "check",
      steps: steps({ running: "check" }),
    };
  }

  snapshot() {
    return this.state;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(state) {
    this.state = state;
    if (this.closed) return;
    for (const listener of this.listeners) {
      try { listener(); } catch { /* A UI subscriber must not interrupt setup/cleanup. */ }
    }
  }

  catalog() {
    return catalogFor(this.config);
  }

  modelPath(file) {
    return join(this.config.downloadRoot, file.name);
  }

  async filesPresent(files) {
    for (const file of files) {
      const info = await stat(this.modelPath(file)).catch(() => undefined);
      if (!info || info.size !== file.bytes) return false;
    }
    return true;
  }

  /** Inspect without network access, imports, installers or model loading. */
  async inspect() {
    if (this.closed || this.task) return;
    const generation = ++this.generation;
    const publish = (state) => {
      if (generation === this.generation && !this.closed) this.publish(state);
    };
    publish({ phase: "checking", startedAt: Date.now(), step: "check", steps: steps({ running: "check" }) });
    try {
      await access(this.config.scriptPath);
      const ready = await this.runtime.isReady();
      if (!ready) {
        if (!this.config.manageRuntime) throw new Error(`Custom Python interpreter is missing: ${this.config.pythonPath}`);
        if (!this.runtime.supported()) throw new Error(`Automatic setup is not yet supported on ${process.platform}-${process.arch}. This release supports macOS 13+ on Apple Silicon.`);
        publish({ phase: "unprepared", steps: steps(), message: "Download and prepare to install isolated Python, recognition dependencies and the model. No system Python or Homebrew is required." });
        return;
      }
      const files = this.catalog();
      const present = files
        ? await this.filesPresent(files)
        : Boolean((await stat(join(this.config.downloadRoot, `${this.config.model}.ckpt`)).catch(() => undefined))?.size);
      publish(present
        ? { phase: "standby", steps: steps({ complete: KINDS }) }
        : { phase: "unprepared", steps: steps({ complete: ["check"] }) });
    } catch (error) {
      publish({ phase: "failed", message: `Recognition environment is not ready: ${messageOf(error)}. Open voice settings and select Download and prepare.`, step: "check", steps: steps({ failed: "check" }) });
    }
  }

  /** Join an active preparation instead of starting a second one. */
  async prepare(options = {}) {
    if (this.closed) throw new Error("GigaAM provider has been disposed");
    if (this.task) return await this.task;
    this.generation++;
    const task = this.run(options).finally(() => {
      if (this.task === task) this.task = undefined;
    });
    this.task = task;
    return await task;
  }

  async run(options) {
    const controller = new AbortController();
    this.abort = controller;
    const signal = controller.signal;
    try {
      this.publish({ phase: "checking", startedAt: Date.now(), step: "check", steps: steps({ running: "check" }) });
      await this.runtime.withLock(async (signal) => {
        signal.throwIfAborted();
        await access(this.config.scriptPath).catch(() => {
          throw new PreparationFailure(`Worker script not found at ${this.config.scriptPath}.`, "check");
        });

        const files = this.catalog();
        if (!files) {
          throw new PreparationFailure(
            `Guided download is available only for ${SUPPORTED_MODEL}. Other models require a custom pythonPath and an externally prepared model cache.`,
            "check",
          );
        }

        // Reject an unconfigured model origin before any runtime download.
        const source = this.pickSource(options?.downloadSource, files[0]);
        try {
          await this.runtime.ensure(signal, (progress) => this.publish({
            phase: progress.totalBytes ? "downloading" : "checking",
            ...progress, startedAt: Date.now(), step: "check", steps: steps({ running: "check" }),
          }));
        } catch (error) {
          throw new PreparationFailure(`Recognition environment preparation failed: ${messageOf(error)}`, "check");
        }
        const missing = [];
        for (const file of files) {
          const info = await stat(this.modelPath(file)).catch(() => undefined);
          if (!info || info.size !== file.bytes) missing.push(file);
        }

        if (missing.length > 0) {
          await mkdir(this.config.downloadRoot, { recursive: true });
          for (const file of missing) {
            await this.download(file, source, signal);
          }
        }

        this.publish({ phase: "checking", startedAt: Date.now(), step: "verify", steps: steps({ complete: ["check", "model"], running: "verify" }) });
        await this.verify(files, signal);

        this.publish({ phase: "loading", startedAt: Date.now(), step: "load", steps: steps({ complete: ["check", "model", "verify"], running: "load" }) });
        if (this.config.loadModel) await this.worker.warmup(signal);

        signal.throwIfAborted();
        this.publish({ phase: "ready", steps: steps({ complete: KINDS }) });
      }, signal);
    } catch (error) {
      if (signal.aborted) {
        const running = KINDS.find((kind) =>
          this.state.steps?.some((step) => step.kind === kind && step.status === "running"),
        );
        this.publish({
          phase: "cancelled",
          steps: steps({ complete: completedBefore(running ?? "load"), cancelled: running ? [running] : [] }),
        });
        return;
      }
      const step = error instanceof PreparationFailure ? error.step : (this.state.step ?? "check");
      this.publish({
        phase: "failed",
        message: messageOf(error),
        step,
        ...(error instanceof PreparationFailure && error.download
          ? { download: error.download }
          : {}),
        steps: steps({ failed: step, complete: completedBefore(step) }),
      });
    } finally {
      this.abort = undefined;
    }
  }

  pickSource(requested, file) {
    if (requested) {
      if (!this.config.origins.includes(requested)) {
        throw new PreparationFailure(
          `Download source is not configured: ${requested}`,
          "model",
          { resource: file.name, source: requested, reason: "unknown" },
        );
      }
      return requested;
    }
    return this.config.origins[0];
  }

  downloadState(resource, completed, total) {
    return {
      phase: "downloading",
      resource,
      completedBytes: completed,
      totalBytes: total,
      step: "model",
      steps: steps({ complete: ["check"], running: "model" }),
    };
  }

  async download(file, origin, signal) {
    try {
      await downloadVerified({ ...file, url: fileUrl(origin, file) }, this.modelPath(file), {
        signal, timeoutMs: this.config.downloadTimeoutMs,
        onProgress: (completed, total) => this.publish(this.downloadState(file.name, completed, total)),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const integrity = /checksum|size|exceeds/i.test(messageOf(error));
      throw new PreparationFailure(
        `Unable to download ${file.name}: ${messageOf(error)}`,
        integrity ? "verify" : "model",
        { resource: file.name, source: origin, ...(integrity ? { reason: "integrity" } : error.status ? { reason: "http", status: error.status } : classify(error)) },
      );
    }
  }

  async verify(files, signal) {
    for (const file of files) {
      signal.throwIfAborted();
      const path = this.modelPath(file);
      const info = await stat(path).catch(() => undefined);
      if (!info || info.size !== file.bytes) {
        throw new PreparationFailure(
          `${file.name} is missing or has the wrong size; download it again.`,
          "verify",
          { resource: file.name, source: this.config.origins[0], reason: "integrity" },
        );
      }
      const expected = file.sha256 ?? file.md5;
      if (!expected) continue;
      const verified = await verifyFile(path, file, signal);
      signal.throwIfAborted();
      if (!verified) {
        await rm(path, { force: true }).catch(() => undefined);
        throw new PreparationFailure(
          `${file.name} failed its checksum and was removed; download it again.`,
          "verify",
          { resource: file.name, source: this.config.origins[0], reason: "integrity" },
        );
      }
    }
  }

  async cancel() {
    if (!this.task) return;
    this.publish({ phase: "cancelling", startedAt: Date.now(), steps: this.state.steps });
    this.abort?.abort();
    await this.task.catch(() => undefined);
  }

  async dispose() {
    this.closed = true;
    this.abort?.abort();
    await this.task?.catch(() => undefined);
    this.listeners.clear();
  }
}
