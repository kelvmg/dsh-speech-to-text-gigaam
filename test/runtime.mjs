import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveConfig } from "../lib/config.js";
import { Preparation } from "../lib/preparation.js";
import { RuntimeManager } from "../lib/runtime.js";
import { UV_ARCHIVES } from "../lib/runtime-manifest.js";

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "gigaam-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = resolveConfig({ dataRoot: root });
  const calls = [];
  const downloads = [];
  let failProbe = false;
  const run = async (command, args, options) => {
    options.signal.throwIfAborted();
    calls.push({ command, args, env: options.env });
    if (args[0] === "-xzf") {
      await writeFile(join(root, "runtime", "tools", "uv"), "fake executable", { mode: 0o755 });
    }
    if (args[0] === "venv") {
      await mkdir(dirname(config.pythonPath), { recursive: true });
      await writeFile(config.pythonPath, "fake Python", { mode: 0o755 });
    }
    if (args.at(-1)?.includes("shutil.copyfile")) {
      await writeFile(join(dirname(config.pythonPath), "ffmpeg"), "fake audio tool", { mode: 0o755 });
    }
    if (args.at(-1)?.includes("import torch") && failProbe) throw new Error("simulated broken torch");
  };
  const download = async (file, path, { signal, onProgress }) => {
    signal.throwIfAborted();
    downloads.push(file.name);
    onProgress(1, file.bytes);
    // Artifact integrity itself is tested by download.mjs, not with real network here.
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "fake verified archive");
  };
  const runtime = new RuntimeManager(config, { platform: "darwin-arm64", run, download, ...overrides });
  return { root, config, runtime, calls, downloads, breakProbe: () => { failProbe = true; } };
}
const signal = () => new AbortController().signal;

test("default interpreter is isolated, explicit custom Python is never managed", () => {
  const config = resolveConfig({ dataRoot: "/some-data" });
  assert.equal(config.manageRuntime, true);
  assert.match(config.pythonPath, /runtime[/\\]venv/);
  assert.equal(resolveConfig({ pythonPath: "/custom/python" }).manageRuntime, false);
  assert.equal(Object.keys(UV_ARCHIVES).join(), "darwin-arm64");
});

test("activation only inspects; missing managed Python shows preparation, without downloads", async (t) => {
  const { config, runtime, calls, downloads } = await fixture(t);
  const preparation = new Preparation(config, {}, runtime);
  await preparation.inspect();
  assert.equal(preparation.snapshot().phase, "unprepared");
  assert.deepEqual(calls, []);
  assert.deepEqual(downloads, []);
});

test("fresh bootstrap installs pinned Python/dependencies and publishes marker only after probe", async (t) => {
  const { config, runtime, calls, downloads } = await fixture(t);
  assert.equal(await runtime.isReady(), false);
  await runtime.ensure(signal());
  assert.equal(await runtime.isReady(), true);
  assert.equal(downloads.length, 2);
  assert.ok(calls.some(({ args }) => args[0] === "python" && args.includes("3.11.14")));
  assert.ok(calls.some(({ args }) => args.includes("--require-hashes") && args.at(-1).endsWith("requirements-macos-arm64.lock")));
  assert.ok(calls.every(({ env }) => env.UV_PYTHON_INSTALL_DIR.startsWith(config.dataRoot)));
  assert.ok(calls.some(({ args }) => args.includes("--no-deps") && args.at(-1).endsWith(".tar.gz")));
  assert.equal(JSON.parse(await readFile(runtime.marker)).fingerprint, runtime.fingerprint);
});

test("ready runtime is reused after restart, no installer/downloads", async (t) => {
  const { config, runtime, calls, downloads } = await fixture(t);
  await runtime.ensure(signal());
  const installed = calls.length;
  const fetched = downloads.length;
  const restarted = new RuntimeManager(config, { platform: "darwin-arm64", run: runtime.run, download: runtime.download });
  await restarted.ensure(signal());
  assert.equal(downloads.length, fetched);
  assert.equal(calls.length, installed + 1);
  assert.equal(await restarted.isReady(), true);
});

test("failed probe leaves no readiness marker and retry can repair", async (t) => {
  let fail = true;
  const f = await fixture(t);
  const realRun = f.runtime.run;
  f.runtime.run = async (...args) => {
    if (fail && args[1].at(-1)?.includes("import torch")) throw new Error("broken installation");
    return realRun(...args);
  };
  await assert.rejects(f.runtime.ensure(signal()), /broken installation/);
  assert.equal(await f.runtime.isReady(), false);
  await assert.rejects(access(f.runtime.marker));
  fail = false;
  await f.runtime.ensure(signal());
  assert.equal(await f.runtime.isReady(), true);
});

test("cancel before/during bootstrap never publishes readiness; subsequent retry succeeds", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(f.runtime.ensure(AbortSignal.abort()), { name: "AbortError" });
  const download = f.runtime.download;
  f.runtime.download = async (...args) => { controller.abort(); args[2].signal.throwIfAborted(); };
  await assert.rejects(f.runtime.ensure(controller.signal), { name: "AbortError" });
  assert.equal(await f.runtime.isReady(), false);
  f.runtime.download = download;
  await f.runtime.ensure(signal());
  assert.equal(await f.runtime.isReady(), true);
});

test("unsupported platform fails before downloads and never claims ready", async (t) => {
  const { runtime, downloads } = await fixture(t, { platform: "darwin-x64" });
  await assert.rejects(runtime.ensure(signal()), /not yet supported/);
  assert.equal(downloads.length, 0);
  assert.equal(await runtime.isReady(), false);
});

test("same-root preparations are mutually exclusive, lock released after failure", async (t) => {
  const { runtime } = await fixture(t);
  await runtime.withLock(async () => {
    await assert.rejects(runtime.withLock(async () => {}), /another session/);
  });
  await assert.rejects(runtime.withLock(async () => { throw new Error("simulated failure"); }), /simulated failure/);
  await runtime.withLock(async () => {});
});

test("empty orphan lock after a crash expires and is automatically recoverable", async (t) => {
  const { root, runtime } = await fixture(t);
  const lock = join(root, ".prepare.lock");
  await mkdir(lock);
  const old = new Date(Date.now() - 180_000);
  await utimes(lock, old, old);
  await runtime.withLock(async () => {});
  await assert.rejects(access(lock));
});

test("managed subprocesses ignore ambient executable/index/version overrides", async (t) => {
  const values = { UV_OVERRIDE: "/bad/override", UV_OFFLINE: "1", UV_INSECURE_HOST: "*", UV_CONFIG_FILE: "/bad/config", PIP_INDEX_URL: "https://bad.invalid", IMAGEIO_FFMPEG_EXE: "/bad/executable", PYTHONPATH: "/bad/module" };
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    const { runtime, calls } = await fixture(t);
    await runtime.ensure(signal());
    for (const { env } of calls) for (const key of Object.keys(values)) assert.equal(env[key], undefined, key);
    assert.equal(calls[0].env.UV_PYTHON_PREFERENCE, "only-managed");
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("stale readiness fingerprint cannot pass inspection", async (t) => {
  const { runtime } = await fixture(t);
  await runtime.ensure(signal());
  await writeFile(runtime.marker, JSON.stringify({ fingerprint: "old-release" }));
  assert.equal(await runtime.isReady(), false);
});

test("slow inspect cannot overwrite a newer preparation state", async (t) => {
  const { config, runtime } = await fixture(t);
  let release;
  runtime.isReady = () => new Promise((resolve) => { release = resolve; });
  const prep = new Preparation(config, {}, runtime);
  const inspect = prep.inspect();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const preparing = prep.prepare({ downloadSource: "https://unconfigured.invalid" });
  await preparing;
  assert.equal(prep.snapshot().phase, "failed");
  release(false);
  await inspect;
  assert.equal(prep.snapshot().phase, "failed");
});
