/**
 * GigaAM speech-to-text provider for the DSH voice-input subsystem.
 *
 * Registers one `speechToText` provider (`gigaam-local`) that transcribes
 * Russian with Sber's GigaAM v3 E2E RNNT model: punctuation and capitalisation
 * included, fully local on the Host CPU. The guided preparation downloads the
 * single supported checkpoint; recordings themselves are handed to a Python
 * worker (`python/gigaam_stt.py`).
 */

import { resolveConfig } from "./config.js";
import { Preparation } from "./preparation.js";
import { GigaamWorker } from "./worker.js";

export const name = "speech-to-text-gigaam";
export const inject = ["speechToText"];

export function apply(ctx, config) {
  const settings = resolveConfig(config ?? {});
  const worker = new GigaamWorker(settings);
  const preparation = new Preparation(settings, worker);

  ctx.effect(() => {
    const unregister = ctx.speechToText.register({
      info: {
        id: settings.providerId,
        name: settings.providerName,
        location: "host-local",
        languages: settings.languages,
        downloadSources: settings.origins,
        setupEstimate: {
          recommendedDiskBytes: 500_000_000,
          expectedMemoryBytes: 1_500_000_000,
          minimumMinutes: 1,
          maximumMinutes: 5,
        },
      },
      preparation,
      transcribe: async (input, signal) => await worker.transcribe(input, signal),
    });

    preparation.inspect();

    return async () => {
      const removing = unregister();
      await preparation.dispose();
      await worker.dispose();
      await removing;
    };
  });
}
