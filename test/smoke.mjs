/**
 * Smoke tests for the GigaAM provider.
 *
 *   node test/smoke.mjs            # uses ~/.dsh/speech-to-text/gigaam
 *   GIGAAM_DATA_ROOT=/path node test/smoke.mjs
 *
 * The tests exercise the real Python worker, so they need a prepared
 * environment (python/setup.sh) and take a few seconds per transcription.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { apply } from "../lib/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT =
  process.env.GIGAAM_DATA_ROOT ?? join(homedir(), ".dsh", "speech-to-text", "gigaam");

function harness(config = {}) {
  const registrations = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    effect(fn) {
      return fn();
    },
    speechToText: {
      register(provider) {
        registrations.push(provider);
        return async () => {};
      },
    },
  };
  apply(ctx, { dataRoot: DATA_ROOT, ...config });
  assert.equal(registrations.length, 1, "exactly one provider should register");
  return registrations[0];
}

const fixture = (name) => readFile(join(HERE, "fixtures", name));

/** Build a canonical 16 kHz mono PCM16 WAV with no samples. */
function emptyWav() {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(0, 40);
  return header;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("registers the gigaam-local provider", async () => {
  const provider = harness();
  assert.equal(provider.info.id, "gigaam-local");
  assert.deepEqual(provider.info.languages, ["auto", "ru", "en"]);
  assert.equal(provider.info.location, "host-local");
});

test("transcribes a short recording and returns the API result shape", async () => {
  const provider = harness();
  const audio = await fixture("short.wav");
  const result = await provider.transcribe({ audio, language: "ru" }, new AbortController().signal);

  assert.equal(typeof result.text, "string");
  assert.match(result.text, /распознаёт русскую речь/);
  assert.ok(result.audioSeconds > 10 && result.audioSeconds < 11);
  assert.ok(result.inferenceSeconds > 0);
});

test("cuts a recording longer than 25 seconds into chunks", async () => {
  const provider = harness();
  const audio = await fixture("long.wav");
  const result = await provider.transcribe({ audio, language: "ru" }, new AbortController().signal);

  assert.ok(result.audioSeconds > 39 && result.audioSeconds < 40);
  assert.match(result.text, /фрагменты/);
  assert.match(result.text, /микрофону/);
});

test("returns empty text for a recording without samples", async () => {
  const provider = harness();
  const result = await provider.transcribe(
    { audio: emptyWav(), language: "ru" },
    new AbortController().signal,
  );
  assert.equal(result.text, "");
  assert.equal(result.audioSeconds, 0);
});

test("respects cancellation", async () => {
  const provider = harness();
  const audio = await fixture("short.wav");
  const controller = new AbortController();
  const pending = provider.transcribe({ audio, language: "ru" }, controller.signal);
  setTimeout(() => controller.abort(), 50);

  await assert.rejects(pending, (error) => {
    assert.equal(error.name, "AbortError");
    return true;
  });
});

test("serializes parallel recordings", async () => {
  const provider = harness();
  const [short, long] = await Promise.all([
    provider.transcribe({ audio: await fixture("short.wav"), language: "ru" }, new AbortController().signal),
    provider.transcribe({ audio: await fixture("long.wav"), language: "ru" }, new AbortController().signal),
  ]);
  assert.ok(short.text.length > 0);
  assert.ok(long.text.length > 0);
});

test("reports a missing interpreter clearly", async () => {
  const provider = harness({ pythonPath: "/nonexistent/python-for-tests" });
  await assert.rejects(
    provider.transcribe({ audio: emptyWav(), language: "ru" }, new AbortController().signal),
    /Download and prepare/,
  );
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
