/**
 * Static configuration for the GigaAM provider: paths, the supported model,
 * pinned file checksums and download origins.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const IS_WINDOWS = process.platform === "win32";
export const DEFAULT_DATA_ROOT = join(homedir(), ".dsh", "speech-to-text", "gigaam");
export const DEFAULT_ORIGIN = "https://cdn.chatwm.opensmodel.sberdevices.ru";
export const SUPPORTED_MODEL = "v3_e2e_rnnt";

/**
 * Files the guided download installs. Checksums come from the GigaAM package
 * (MD5 of the checkpoint) and from the published Hugging Face blob (SHA-256 of
 * the tokenizer).
 */
export const MODEL_FILES = [
  {
    name: "v3_e2e_rnnt.ckpt",
    bytes: 448_929_252,
    md5: "2730de7545ac43ad256485a462b0a27a",
  },
  {
    name: "v3_e2e_rnnt_tokenizer.model",
    bytes: 255_336,
    sha256: "828c12c991019eef952a960661f25a92d6ad279591e2ea466b4aeddf1d20a18a",
  },
];

const DEFAULT_LANGUAGES = ["auto", "ru", "en"];
const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_CHUNK_SECONDS = 20;
const MIN_CHUNK_SECONDS = 3;
// GigaAM accepts at most 25 s per call; stay just below the limit.
const MAX_CHUNK_SECONDS = 24.5;

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Normalize configured origins to unique http(s) origins. */
export function normalizeOrigins(values) {
  const origins = [];
  for (const value of values ?? [DEFAULT_ORIGIN]) {
    try {
      const origin = new URL(String(value)).origin;
      if (/^https?:$/.test(new URL(String(value)).protocol) && !origins.includes(origin)) {
        origins.push(origin);
      }
    } catch {
      // Ignore malformed origins; the default stays available when the list empties.
    }
  }
  return origins.length > 0 ? origins : [DEFAULT_ORIGIN];
}

/** Normalize the row config so every consumer sees absolute, valid values. */
export function resolveConfig(raw = {}) {
  const dataRoot = raw.dataRoot ?? DEFAULT_DATA_ROOT;
  return {
    providerId: raw.providerId ?? "gigaam-local",
    providerName: raw.providerName ?? "GigaAM v3 · Russian (punctuation)",
    pythonPath:
      raw.pythonPath ??
      join(dataRoot, "venv", IS_WINDOWS ? "Scripts" : "bin", IS_WINDOWS ? "python.exe" : "python"),
    scriptPath: raw.scriptPath ?? join(PACKAGE_DIR, "python", "gigaam_stt.py"),
    downloadRoot: raw.downloadRoot ?? join(dataRoot, "models"),
    model: raw.model ?? SUPPORTED_MODEL,
    device: raw.device ?? "cpu",
    maxChunkSeconds: clamp(
      positive(raw.maxChunkSeconds, DEFAULT_MAX_CHUNK_SECONDS),
      MIN_CHUNK_SECONDS,
      MAX_CHUNK_SECONDS,
    ),
    timeoutMs: positive(raw.timeoutMs, DEFAULT_TIMEOUT_MS),
    languages:
      Array.isArray(raw.languages) && raw.languages.length > 0
        ? raw.languages.map(String)
        : DEFAULT_LANGUAGES,
    origins: normalizeOrigins(raw.downloadSources ?? raw.modelOrigins),
    loadModel: raw.loadModel !== false,
    modelFiles: Array.isArray(raw.modelFiles) ? raw.modelFiles : undefined,
  };
}

/** Files the guided download manages for the configured model, if known. */
export function catalogFor(config) {
  if (Array.isArray(config.modelFiles) && config.modelFiles.length > 0) return config.modelFiles;
  if (config.model === SUPPORTED_MODEL) return MODEL_FILES;
  return undefined;
}

/** Origin-absolute URL for one model file. */
export function fileUrl(origin, file) {
  return new URL(`GigaAM/${file.name}`, `${origin}/`).href;
}

/** GUI-launched apps inherit a minimal PATH; ffmpeg usually sits elsewhere. */
export function toolPath() {
  const prefixes = IS_WINDOWS
    ? []
    : ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];
  return [...prefixes, process.env.PATH].filter(Boolean).join(IS_WINDOWS ? ";" : ":");
}
