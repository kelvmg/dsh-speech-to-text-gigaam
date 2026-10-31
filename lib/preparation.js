/**
 * Host-owned preparation for the single supported GigaAM model.
 *
 * The provider never downloads on activation: `inspect()` only stats the
 * cache, so the voice UI can show an explicit "Download and prepare" card.
 * `prepare()` checks the Python environment, downloads the checkpoint and
 * tokenizer with progress, verifies their size and checksum, then loads the
 * model once so the first dictation does not pay for it.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { catalogFor, fileUrl, SUPPORTED_MODEL } from "./config.js";

const KINDS = ["check", "model", "verify", "load"];
const PROGRESS_INTERVAL_MS = 100;

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

async function fileHash(path, algorithm) {
  const hash = createHash(algorithm);
  const stream = createReadStream(path);
  await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

export class Preparation {
  constructor(config, worker) {
    this.config = config;
    this.worker = worker;
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
    for (const listener of this.listeners) listener();
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

  /** Stat the cache without downloading anything. */
  async inspect() {
    const startedAt = Date.now();
    this.publish({ phase: "checking", startedAt, step: "check", steps: steps({ running: "check" }) });
    try {
      await access(this.config.pythonPath);
      await access(this.config.scriptPath);
      const files = this.catalog();
      const present = files
        ? await this.filesPresent(files)
        : Boolean((await stat(join(this.config.downloadRoot, `${this.config.model}.ckpt`)).catch(() => undefined))?.size);
      this.publish(
        present
          ? { phase: "standby", steps: steps({ complete: KINDS }) }
          : { phase: "unprepared", steps: steps({ complete: ["check"] }) },
      );
    } catch (error) {
      this.publish({
        phase: "failed",
        message: `Recognition environment is not ready: ${messageOf(error)}. Run python/setup.sh to create the Python environment.`,
        step: "check",
        steps: steps({ failed: "check" }),
      });
    }
  }

  /** Join an active preparation instead of starting a second one. */
  async prepare(options = {}) {
    if (this.task) return await this.task;
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
      await access(this.config.pythonPath).catch(() => {
        throw new PreparationFailure(
          `Python environment not found at ${this.config.pythonPath}. Run python/setup.sh first.`,
          "check",
        );
      });
      await access(this.config.scriptPath).catch(() => {
        throw new PreparationFailure(`Worker script not found at ${this.config.scriptPath}.`, "check");
      });

      const files = this.catalog();
      if (!files) {
        throw new PreparationFailure(
          `Guided download is available only for ${SUPPORTED_MODEL}. Run python/setup.sh to install '${this.config.model}'.`,
          "check",
        );
      }

      const source = this.pickSource(options?.downloadSource, files[0]);
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

      this.publish({ phase: "ready", steps: steps({ complete: KINDS }) });
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
      const step = error instanceof PreparationFailure ? error.step : "model";
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
    const url = fileUrl(origin, file);
    let response;
    try {
      response = await fetch(url, { signal, redirect: "follow" });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new PreparationFailure(
        `Unable to download ${file.name}: ${messageOf(error)}`,
        "model",
        { resource: file.name, source: origin, ...classify(error) },
      );
    }
    if (!response.ok || !response.body) {
      throw new PreparationFailure(
        `Unable to download ${file.name}: HTTP ${response.status}`,
        "model",
        { resource: file.name, source: origin, reason: "http", status: response.status },
      );
    }

    const total = Number(response.headers.get("content-length")) || file.bytes;
    const destination = this.modelPath(file);
    const temporary = `${destination}.part`;
    const algorithm = file.md5 ? "md5" : "sha256";
    const hash = createHash(algorithm);
    let received = 0;
    let lastProgress = 0;

    this.publish(this.downloadState(file.name, 0, total));
    const meter = new Transform({
      transform: (chunk, _encoding, callback) => {
        received += chunk.length;
        hash.update(chunk);
        const now = Date.now();
        if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
          lastProgress = now;
          this.publish(this.downloadState(file.name, received, total));
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary), { signal });
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (signal.aborted) throw error;
      throw new PreparationFailure(
        `Unable to download ${file.name}: ${messageOf(error)}`,
        "model",
        { resource: file.name, source: origin, ...classify(error) },
      );
    }

    const expected = file.md5 ?? file.sha256;
    if (expected && hash.digest("hex") !== expected) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new PreparationFailure(
        `Downloaded ${file.name} failed its checksum; try again.`,
        "verify",
        { resource: file.name, source: origin, reason: "integrity" },
      );
    }
    await rename(temporary, destination);
    this.publish(this.downloadState(file.name, total, total));
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
      const expected = file.md5 ?? file.sha256;
      if (!expected) continue;
      const digest = await fileHash(path, file.md5 ? "md5" : "sha256");
      signal.throwIfAborted();
      if (digest !== expected) {
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
