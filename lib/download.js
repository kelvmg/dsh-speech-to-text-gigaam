import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function verifyFile(path, file, signal) {
  signal?.throwIfAborted();
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile() || info.size !== file.bytes) return false;
  const hash = createHash(file.sha256 ? "sha256" : "md5");
  for await (const chunk of createReadStream(path)) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  signal?.throwIfAborted();
  return hash.digest("hex") === (file.sha256 ?? file.md5);
}

/** Bounded, deadline-limited download. Never publish an unverified executable/model. */
export async function downloadVerified(file, destination, { signal, onProgress = () => {}, fetchImpl = fetch, timeoutMs = 900_000 } = {}) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException("Download timed out", "TimeoutError")), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const temporary = `${destination}.part-${randomUUID()}`;
  let response;
  try {
    combined.throwIfAborted();
    response = await fetchImpl(file.url, { signal: combined, redirect: "follow" });
    if (!response.ok || !response.body) {
      const error = new Error(`Unable to download ${file.name}: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) !== file.bytes) {
      throw new Error(`${file.name}: unexpected download size (expected ${file.bytes} bytes)`);
    }
    await mkdir(dirname(destination), { recursive: true });
    const hash = createHash(file.sha256 ? "sha256" : "md5");
    let received = 0;
    let lastProgress = 0;
    onProgress(0, file.bytes);
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > file.bytes) return callback(new Error(`${file.name}: download exceeds expected size`));
        hash.update(chunk);
        if (Date.now() - lastProgress >= 100) {
          lastProgress = Date.now();
          onProgress(received, file.bytes);
        }
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, { flags: "wx", mode: 0o600 }), { signal: combined });
    combined.throwIfAborted();
    if (received !== file.bytes || hash.digest("hex") !== (file.sha256 ?? file.md5)) {
      throw new Error(`${file.name} failed its checksum or size verification`);
    }
    await rename(temporary, destination);
    onProgress(received, file.bytes);
  } catch (error) {
    if (deadline.signal.aborted && !signal?.aborted) throw deadline.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    await response?.body?.cancel().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}
