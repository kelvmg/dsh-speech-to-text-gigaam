import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { GigaamWorker } from "../lib/worker.js";
import { runProcess } from "../lib/process.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const config = () => ({ pythonPath: process.execPath, scriptPath: "worker.py", model: "test-model",
  device: "cpu", maxChunkSeconds: 3, downloadRoot: tmpdir(), timeoutMs: 3000 });
const audio = Buffer.alloc(44 + 32000);
const turn = () => new Promise((resolve) => setImmediate(resolve));

// Real child processes, but no Python/model/network dependencies.
for (const reason of ["abort", "timeout"]) {
  test(`runProcess waits for child close before rejecting on ${reason}`, { timeout: 5000 }, async () => {
    const controller = new AbortController();
    let closed = false;
    let finished = false;
    let child;
    const pending = runProcess(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], {
      signal: controller.signal,
      timeoutMs: reason === "timeout" ? 80 : 3000,
      onSpawn(value) { child = value; child.on("close", () => { closed = true; }); },
      onOutput() { if (reason === "abort") controller.abort(); },
      onFinish(value) { assert.equal(value, child); finished = true; },
    });
    await assert.rejects(pending, reason === "abort" ? { name: "AbortError" } : /timed out/);
    assert.ok(closed, "must not reject before child close");
    assert.ok(finished, "onFinish must run before rejection");
  });
}

test("pre-aborted process never spawns", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runProcess(process.execPath, [], {
    signal: controller.signal, onSpawn() { assert.fail("unexpected child"); },
  }), { name: "AbortError" });
});

test("queued cancellation rejects promptly without waiting for prior job", { timeout: 3000 }, async (t) => {
  const worker = new GigaamWorker(config());
  const gate = deferred();
  const started = deferred();
  let calls = 0;
  worker.spawn = async () => { calls++; started.resolve(); await gate.promise; };
  t.after(async () => { gate.resolve(); await worker.dispose(); });
  const first = worker.warmup();
  await started.promise;
  const controller = new AbortController();
  const second = worker.warmup(controller.signal);
  const rejected = assert.rejects(second, { name: "AbortError" });
  controller.abort();
  await rejected; // The first job is deliberately still blocked.
  assert.equal(calls, 1);
  gate.resolve();
  await first;
  await worker.tail;
  assert.equal(calls, 1, "cancelled queued job must never start");
});

test("warmup and transcription share queue, device and model configuration", { timeout: 3000 }, async (t) => {
  const worker = new GigaamWorker({ ...config(), device: "mps" });
  const gate = deferred();
  const started = deferred();
  const calls = [];
  let wavPath;
  worker.spawn = async (_command, args) => {
    calls.push(args);
    if (args.includes("--warmup")) { started.resolve(); await gate.promise; }
    else {
      wavPath = args[args.indexOf("--input") + 1];
      await access(wavPath);
      await writeFile(args[args.indexOf("--output") + 1], "  recognized text\n");
    }
  };
  t.after(async () => { gate.resolve(); await worker.dispose(); });
  const warmup = worker.warmup();
  await started.promise;
  const transcription = worker.transcribe({ audio });
  await turn();
  assert.equal(calls.length, 1);
  gate.resolve();
  await warmup;
  const result = await transcription;
  assert.equal(result.text, "recognized text");
  assert.equal(result.audioSeconds, 1);
  assert.equal(calls.length, 2);
  for (const args of calls) {
    assert.equal(args[args.indexOf("--device") + 1], "mps");
    assert.equal(args[args.indexOf("--model") + 1], "test-model");
  }
  await assert.rejects(access(dirname(wavPath)), { code: "ENOENT" });
});

test("dispose aborts active warmup and waits for process close", { timeout: 5000 }, async (t) => {
  const worker = new GigaamWorker(config());
  const started = deferred();
  let closed = false;
  worker.spawn = (_command, _args, signal) => runProcess(process.execPath,
    ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], {
      signal, timeoutMs: 3000,
      onOutput() { started.resolve(); },
      onSpawn(child) { child.on("close", () => { closed = true; }); },
    });
  t.after(() => worker.dispose());
  const warmup = worker.warmup();
  const rejected = assert.rejects(warmup, { name: "AbortError" });
  await started.promise;
  await worker.dispose();
  assert.ok(closed);
  await rejected;
  await assert.rejects(worker.warmup(), { name: "AbortError" });
  await assert.rejects(worker.transcribe({ audio }), { name: "AbortError" });
});

test("active abort reaps child before audio cleanup and next queued job", { timeout: 5000 }, async (t) => {
  const worker = new GigaamWorker(config());
  const controller = new AbortController();
  const ready = deferred();
  let wavPath;
  let presentAtClose = false;
  let closed = false;
  worker.spawn = (_command, args, signal) => {
    if (args.includes("--warmup")) {
      assert.ok(closed, "next job cannot overlap the cancelled child");
      assert.equal(existsSync(dirname(wavPath)), false, "next job must wait for audio cleanup");
      return Promise.resolve();
    }
    wavPath = args[args.indexOf("--input") + 1];
    return runProcess(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], {
      signal, timeoutMs: 3000,
      onOutput() { ready.resolve(); },
      onFinish() { closed = true; presentAtClose = existsSync(wavPath); },
    });
  };
  t.after(() => worker.dispose());
  const pending = worker.transcribe({ audio }, controller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await ready.promise;
  const next = worker.warmup();
  controller.abort();
  await rejected;
  assert.ok(presentAtClose, "audio must remain available until child close");
  assert.equal(existsSync(dirname(wavPath)), false);
  await next;
});

test("missing interpreter reports GUI preparation action", { timeout: 3000 }, async (t) => {
  const worker = new GigaamWorker({ ...config(), pythonPath: join(tmpdir(), `missing-gigaam-python-${process.pid}`) });
  t.after(() => worker.dispose());
  await assert.rejects(worker.warmup(), /interpreter not found.*Download and prepare/);
  assert.equal(worker.current, undefined);
});

test("failed job does not block the next queued job", async (t) => {
  const worker = new GigaamWorker(config());
  let calls = 0;
  worker.spawn = async () => { if (++calls === 1) throw new Error("first failed"); };
  t.after(() => worker.dispose());
  const first = worker.warmup();
  const second = worker.warmup();
  await assert.rejects(first, /first failed/);
  await second;
  assert.equal(calls, 2);
});
