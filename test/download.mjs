import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { downloadVerified, verifyFile } from "../lib/download.js";

const payload = Buffer.from("verified local fixture\n");
const hash = (data, algorithm = "sha256") => createHash(algorithm).update(data).digest("hex");
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t, handler, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gigaam-download-test-"));
  const server = createServer(handler);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const file = { name: "fixture.bin", bytes: payload.length, sha256: hash(payload),
    url: `http://127.0.0.1:${server.address().port}/fixture`, ...overrides };
  const destination = join(directory, "fixture.bin");
  return { directory, destination, file };
}

async function assertClean(directory, destination, { exists = false } = {}) {
  assert.deepEqual((await readdir(directory)).filter((name) => name.includes(".part-")), []);
  if (!exists) await assert.rejects(access(destination), { code: "ENOENT" });
}

test("known SHA256 payload downloads, verifies and reports progress", { timeout: 5000 }, async (t) => {
  const { directory, destination, file } = await fixture(t, (_request, response) => {
    response.writeHead(200, { "content-length": payload.length });
    response.end(payload);
  });
  const progress = [];
  await downloadVerified(file, destination, { onProgress: (...value) => progress.push(value), timeoutMs: 2000 });
  assert.deepEqual(await readFile(destination), payload);
  assert.equal(await verifyFile(destination, file), true);
  assert.deepEqual(progress[0], [0, payload.length]);
  assert.deepEqual(progress.at(-1), [payload.length, payload.length]);
  await assertClean(directory, destination, { exists: true });
});

test("known MD5 payload is supported", { timeout: 5000 }, async (t) => {
  const { destination, file } = await fixture(t, (_request, response) => response.end(payload),
    { sha256: undefined, md5: hash(payload, "md5") });
  await downloadVerified(file, destination, { timeoutMs: 2000 });
  assert.equal(await verifyFile(destination, file), true);
});

test("chunked response without content-length cannot exceed byte cap", { timeout: 5000 }, async (t) => {
  const { directory, destination, file } = await fixture(t, (_request, response) => {
    response.writeHead(200);
    response.write(Buffer.alloc(payload.length + 1, 1));
    response.end();
  });
  await assert.rejects(downloadVerified(file, destination, { timeoutMs: 2000 }), /exceeds expected size/);
  await assertClean(directory, destination);
});

test("checksum mismatch preserves previously published destination", { timeout: 5000 }, async (t) => {
  const { directory, destination, file } = await fixture(t, (_request, response) => response.end(Buffer.alloc(payload.length)));
  const previous = Buffer.from("previous verified executable");
  await writeFile(destination, previous);
  await assert.rejects(downloadVerified(file, destination, { timeoutMs: 2000 }), /checksum or size verification/);
  assert.deepEqual(await readFile(destination), previous);
  await assertClean(directory, destination, { exists: true });
});

test("short chunked body fails size verification and removes partial file", { timeout: 5000 }, async (t) => {
  const { directory, destination, file } = await fixture(t, (_request, response) => {
    response.writeHead(200);
    response.write(payload.subarray(0, 3));
    response.end();
  });
  await assert.rejects(downloadVerified(file, destination, { timeoutMs: 2000 }), /checksum or size verification/);
  await assertClean(directory, destination);
});

test("unexpected declared content length fails without publishing", { timeout: 5000 }, async (t) => {
  const { directory, destination, file } = await fixture(t, (_request, response) => {
    response.writeHead(200, { "content-length": payload.length + 1 });
    response.end(Buffer.alloc(payload.length + 1));
  });
  await assert.rejects(downloadVerified(file, destination, { timeoutMs: 2000 }), /unexpected download size/);
  await assertClean(directory, destination);
});

test("abort during stalled stream rejects and cleans partial file", { timeout: 5000 }, async (t) => {
  const { directory, destination, file } = await fixture(t, (_request, response) => {
    response.writeHead(200);
    response.write(payload.subarray(0, 3));
  });
  const controller = new AbortController();
  await assert.rejects(downloadVerified(file, destination, {
    signal: controller.signal, timeoutMs: 2000,
    onProgress(received) { if (received > 0) controller.abort(); },
  }), { name: "AbortError" });
  await assertClean(directory, destination);
});

test("deadline covers stalled response body, not just headers", { timeout: 5000 }, async (t) => {
  const { directory, destination, file } = await fixture(t, (_request, response) => {
    response.writeHead(200);
    response.write(payload.subarray(0, 3));
  });
  const started = Date.now();
  await assert.rejects(downloadVerified(file, destination, { timeoutMs: 80 }), { name: "TimeoutError" });
  assert.ok(Date.now() - started < 2000);
  await assertClean(directory, destination);
});

test("destination stays unpublished until entire stream is verified", { timeout: 5000 }, async (t) => {
  const release = deferred();
  const receiving = deferred();
  const { directory, destination, file } = await fixture(t, (_request, response) => {
    response.writeHead(200);
    response.write(payload.subarray(0, 3));
    void release.promise.then(() => response.end(payload.subarray(3)));
  });
  t.after(() => release.resolve());
  const pending = downloadVerified(file, destination, {
    timeoutMs: 2000,
    onProgress(received) { if (received > 0) receiving.resolve(); },
  });
  // Attach rejection handler immediately so assertion failures cannot cause an unhandled rejection.
  pending.catch(() => {});
  await receiving.promise;
  await assert.rejects(access(destination), { code: "ENOENT" });
  release.resolve();
  await pending;
  assert.deepEqual(await readFile(destination), payload);
  await assertClean(directory, destination, { exists: true });
});

test("pre-aborted request performs no fetch", { timeout: 5000 }, async (t) => {
  let requested = false;
  const { directory, destination, file } = await fixture(t, (_request, response) => {
    requested = true;
    response.end(payload);
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(downloadVerified(file, destination, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(requested, false);
  await assertClean(directory, destination);
});

test("HTTP failure includes status and leaves no partial file", { timeout: 5000 }, async (t) => {
  const { directory, destination, file } = await fixture(t, (_request, response) => {
    response.writeHead(503);
    response.end("unavailable");
  });
  await assert.rejects(downloadVerified(file, destination), { status: 503 });
  await assertClean(directory, destination);
});
