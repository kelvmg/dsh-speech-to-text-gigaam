#!/usr/bin/env node
/** Optional headless equivalent of the voice UI's explicit prepare button. */
import { resolveConfig } from "./config.js";
import { Preparation } from "./preparation.js";
import { GigaamWorker } from "./worker.js";
const config = resolveConfig({ dataRoot: process.env.GIGAAM_DATA_ROOT });
const worker = new GigaamWorker(config);
const preparation = new Preparation(config, worker);
const unsubscribe = preparation.subscribe(() => {
  const state = preparation.snapshot();
  console.log(JSON.stringify({ phase: state.phase, step: state.step, resource: state.resource,
    completedBytes: state.completedBytes, totalBytes: state.totalBytes, message: state.message }));
});
const cancel = () => { void preparation.cancel(); };
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
try {
  await preparation.prepare();
  const phase = preparation.snapshot().phase;
  process.exitCode = phase === "ready" ? 0 : phase === "cancelled" ? 130 : 1;
} finally {
  unsubscribe();
  await preparation.dispose();
  await worker.dispose();
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
