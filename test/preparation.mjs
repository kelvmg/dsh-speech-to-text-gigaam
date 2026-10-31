/**
 * Unit tests for guided model preparation.
 *
 *   node test/preparation.mjs
 *
 * Uses a local HTTP server and a tiny fake checkpoint, so no real model is
 * downloaded and no Python is spawned (`loadModel: false`).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveConfig } from "../lib/config.js";
import { Preparation } from "../lib/preparation.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "python", "gigaam_stt.py");
const PAYLOAD = Buffer.alloc(64 * 1024, 7);
const PAYLOAD_SHA256 = createHash("sha256").update(PAYLOAD).digest("hex");

function fakeWorker() {
  return { warmup: async () => undefined };
}

function makeConfig({ downloadRoot, origin, pythonPath = process.execPath, files }) {
  return resolveConfig({
    dataRoot: downloadRoot,
    downloadRoot,
    pythonPath,
    scriptPath: SCRIPT,
    origins: [origin],
    downloadSources: [origin],
    loadModel: false,
    modelFiles: files,
  });
}

/** Serve `/GigaAM/<name>` with configurable bytes and pacing. */
async function startServer({ body = PAYLOAD, chunkDelayMs = 0, chunkSize = 16 * 1024 } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push(request.url);
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(body.length),
    });
    for (let offset = 0; offset < body.length; offset += chunkSize) {
      response.write(body.subarray(offset, offset + chunkSize));
      if (chunkDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
    }
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function waitForPhase(preparation, phase, timeoutMs = 5000) {
  if (preparation.snapshot().phase === phase) return Promise.resolve(preparation.snapshot());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${phase}`)), timeoutMs);
    const unsubscribe = preparation.subscribe(() => {
      if (preparation.snapshot().phase === phase) {
        clearTimeout(timer);
        unsubscribe();
        resolve(preparation.snapshot());
      }
    });
  });
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("inspect reports unprepared when the cache is empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "gigaam-prep-"));
  try {
    const preparation = new Preparation(
      makeConfig({ downloadRoot: root, origin: "http://127.0.0.1:9" }),
      fakeWorker(),
    );
    await preparation.inspect();
    assert.equal(preparation.snapshot().phase, "unprepared");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect reports failed when the interpreter is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "gigaam-prep-"));
  try {
    const preparation = new Preparation(
      makeConfig({ downloadRoot: root, origin: "http://127.0.0.1:9", pythonPath: "/nonexistent/python" }),
      fakeWorker(),
    );
    await preparation.inspect();
    const state = preparation.snapshot();
    assert.equal(state.phase, "failed");
    assert.match(state.message, /setup\.sh/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepare downloads, verifies and reports progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "gigaam-prep-"));
  const server = await startServer();
  try {
    const file = { name: "fake.ckpt", bytes: PAYLOAD.length, sha256: PAYLOAD_SHA256 };
    const preparation = new Preparation(
      makeConfig({ downloadRoot: root, origin: server.origin, files: [file] }),
      fakeWorker(),
    );
    const phases = [];
    preparation.subscribe(() => phases.push(preparation.snapshot().phase));

    await preparation.prepare({});
    assert.equal(preparation.snapshot().phase, "ready");
    assert.ok(phases.includes("downloading"));
    assert.ok(phases.includes("loading"));

    const stored = await readFile(join(root, "fake.ckpt"));
    assert.equal(stored.length, PAYLOAD.length);
    assert.equal(createHash("sha256").update(stored).digest("hex"), PAYLOAD_SHA256);

    // A second prepare must not download again.
    await preparation.prepare({});
    assert.equal(server.requests.length, 1);
    assert.equal(preparation.snapshot().phase, "ready");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("prepare rejects a checksum mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "gigaam-prep-"));
  const server = await startServer({ body: Buffer.alloc(4096, 1) });
  try {
    const file = { name: "fake.ckpt", bytes: PAYLOAD.length, sha256: PAYLOAD_SHA256 };
    const preparation = new Preparation(
      makeConfig({ downloadRoot: root, origin: server.origin, files: [file] }),
      fakeWorker(),
    );
    await preparation.prepare({});
    const state = preparation.snapshot();
    assert.equal(state.phase, "failed");
    assert.equal(state.download?.reason, "integrity");
    await assert.rejects(stat(join(root, "fake.ckpt")));
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel interrupts an active download", async () => {
  const root = await mkdtemp(join(tmpdir(), "gigaam-prep-"));
  const server = await startServer({ chunkDelayMs: 40 });
  try {
    const file = { name: "fake.ckpt", bytes: PAYLOAD.length, sha256: PAYLOAD_SHA256 };
    const preparation = new Preparation(
      makeConfig({ downloadRoot: root, origin: server.origin, files: [file] }),
      fakeWorker(),
    );
    const running = preparation.prepare({});
    await waitForPhase(preparation, "downloading");
    await preparation.cancel();
    await running.catch(() => undefined);
    assert.equal(preparation.snapshot().phase, "cancelled");
    await assert.rejects(stat(join(root, "fake.ckpt")));
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("prepare rejects an unconfigured download source", async () => {
  const root = await mkdtemp(join(tmpdir(), "gigaam-prep-"));
  try {
    const file = { name: "fake.ckpt", bytes: PAYLOAD.length, sha256: PAYLOAD_SHA256 };
    const preparation = new Preparation(
      makeConfig({ downloadRoot: root, origin: "https://cdn.example", files: [file] }),
      fakeWorker(),
    );
    await preparation.prepare({ downloadSource: "https://evil.example" });
    const state = preparation.snapshot();
    assert.equal(state.phase, "failed");
    assert.equal(state.step, "model");
    assert.match(state.message, /not configured/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  const started = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}

if (failed > 0) {
  console.error(`\n${failed}/${tests.length} test(s) failed`);
  process.exit(1);
}
console.log(`\n${tests.length} tests passed`);
