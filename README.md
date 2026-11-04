# dsh-speech-to-text-gigaam

Local **Russian speech recognition for DeepSeek Harness**, powered by
[Sber GigaAM v3 E2E RNNT](https://github.com/salute-developers/GigaAM).
Punctuation and capitalisation are included. Audio and transcripts stay on the host.

## Install and prepare — no terminal required

1. In DSH, open **Plugins → Add plugin** and install
   `https://github.com/kelvmg/dsh-speech-to-text-gigaam`. Enable the bundle.
2. Open voice settings, select **GigaAM v3 · Russian (punctuation)** and `ru` or `auto`.
3. Click **Download and prepare**. The plugin installs its own Python, PyTorch,
   GigaAM, audio tools and recognition model. Progress, cancellation and retry are
   available in the existing voice preparation card.
4. Start dictation once preparation finishes.

**Automatic setup in 0.4.0 supports macOS on Apple Silicon (arm64, macOS 13+).**
No system Python, Homebrew, git or separately installed ffmpeg is required.
Other platforms fail with an explicit explanation before downloading anything;
advanced users can provide a prepared interpreter with `pythonPath`.
Intel Mac is not supported by automatic setup: its last official PyTorch build
conflicts with the current GigaAM NumPy requirements.

Requires DSH with `@deepseek-ai/dsh-experimental-voice-input-bundle` and Node 20.3+
(the DSH host supplies Node). Reserve **4 GB disk**, approximately **2 GB RAM**;
initial setup normally takes **3–20 minutes**, depending on the network and machine.

## What preparation does

Activation only checks local resources: **no background downloads or installers**.
The existing `check → model → verify → load` preparation contract is retained.

- **Check:** download SHA-256-verified uv 0.9.7, install private CPython 3.11.14,
  create a private environment and install the checked-in dependency lockfile with
  `--require-hashes`. PyTorch and torchaudio are both 2.8.0. GigaAM source is pinned
  to commit `7447938d791c4f3e643386ee22c33777004293a5` and SHA-256 verified.
  ffmpeg comes from `imageio-ffmpeg==0.6.0`, not a system package manager.
- **Model:** download `v3_e2e_rnnt.ckpt` (448,929,252 bytes) and tokenizer
  (255,336 bytes) from Sber's CDN. This is the only guided model.
- **Verify:** verify sizes, the checkpoint's upstream MD5 and tokenizer SHA-256.
- **Load:** warm up the model using the configured device. Inference and warmup
  share a single process queue.

Files persist under `~/.dsh/speech-to-text/gigaam`:

```text
runtime/       private installer, Python, venv, package cache and readiness marker
models/        recognition checkpoint and tokenizer
```

An interrupted installation never creates a readiness marker. Retry reuses valid
archives, downloaded Python and package cache. Completed models are reused too;
a partially downloaded model starts over (HTTP Range resume is not implemented).
Preparation has a heartbeat lock to prevent overlapping sessions. After a host
crash, a stale lock expires within two minutes; retry then.

**Upgrade from 0.3:** existing `models/` are reused; the old manually created
`venv/` is left untouched. The default moves to `runtime/venv/`, so click
**Download and prepare** once after updating. To retain a manually prepared
interpreter instead, explicitly set its absolute `pythonPath`.

## Network, privacy and integrity

Setup contacts GitHub (uv, pinned standalone Python and GigaAM source),
`pypi.org`/`files.pythonhosted.org` (Python distributions) and
`cdn.chatwm.opensmodel.sberdevices.ru` (recognition model). The source selector in
voice settings applies **only to model files**, not runtime dependencies.

Runtime archives, source and locked Python distributions are verified against
pinned hashes. uv verifies standalone Python using its pinned download catalog.
Python build tooling still uses isolated build environments and the HTTPS PyPI
index; this is not a completely hermetic/offline build. Setup does not alter
system Python, shell profiles or global PATH. Ambient pip/uv configuration and
`IMAGEIO_FFMPEG_EXE` do not override managed setup; normal certificate/proxy
settings remain usable.

Downloads have deadlines and exact byte caps; corrupt or partial files are not
published as final assets. Cancel kills the process group and waits for process
exit before deleting temporary audio or starting another job. Recordings are
transcribed locally and temporary WAV/transcript files are removed afterwards.
Errors write diagnostic traces to `dsh-gigaam-stt.log` in the system temp directory.
No audio, transcript or telemetry is uploaded.

## Configuration

Defaults are in `cordis.patch.yml`; advanced options on `speech-to-text-gigaam`:

| Option | Default / purpose |
| --- | --- |
| `dataRoot` | `~/.dsh/speech-to-text/gigaam` |
| `pythonPath` | `dataRoot/runtime/venv/bin/python`; an explicit path disables managed installs |
| `downloadRoot` | `dataRoot/models` |
| `model` | `v3_e2e_rnnt`; other models require an externally prepared environment and cache |
| `device` | `cpu`; `auto` may choose MPS; only CPU is smoke-tested |
| `maxChunkSeconds` | `20`; clamped to `3…24.5`; every sample is retained |
| `timeoutMs` | `900000` per recognition/warmup job |
| `setupTimeoutMs` | `1800000` per installer command/download |
| `downloadTimeoutMs` | `900000` per model download |
| `downloadSources` | Sber CDN origin; additional trusted model mirrors are optional |
| `loadModel` | `true`; disable only for diagnostics/tests |

Unsupported guided models fail before any installation. An explicit custom
`pythonPath` must already contain all dependencies and ffmpeg; the plugin never
installs packages into a user-specified interpreter.

## Development and headless preparation

```sh
npm ci
npm test                         # model-free Node regressions
# Optional terminal equivalent of the explicit UI prepare button:
npm run setup:runtime
npm run test:smoke               # real model: 7 recognition/integration tests
# Python-only regressions, using the prepared runtime:
~/.dsh/speech-to-text/gigaam/runtime/venv/bin/python -B -m unittest discover -s test -p python_worker.py -v
```

`GIGAAM_DATA_ROOT=/absolute/test-directory` selects an independent data root for
headless preparation and smoke tests. `python/setup.sh` is a compatibility wrapper
for the same Node-based preparation; it no longer calls system Python or git.
The dependency lockfile can be regenerated using pinned uv with
`uv pip compile --generate-hashes --no-header --no-annotate` from
`python/requirements-macos-arm64.in`; update the lock digest in the manifest too.

## Changelog

- **0.4.0** — one-click isolated Python/dependency/audio-tool setup on Apple Silicon;
  pinned runtime/source and hashed dependency lock; cache reuse, cancel/retry and
  honest resource estimates. Fix infinite/oversized chunking and lost short tails,
  queued cancellation, child-reaping/cleanup races, warmup serialization and device
  propagation. Add bounded downloads and bootstrap/process/audio regressions.
- **0.3.0** — guided single-model download, progress, cancellation and checksums.
- **0.2.0** — voice API result shape, portable paths and smoke tests.
- **0.1.0** — initial provider.

## License

MIT © 2026 Evgeny Klimov. GigaAM is MIT-licensed by SberDevices. uv, PyTorch and
ffmpeg retain their own upstream licenses. Runtime binaries are downloaded on
request, not embedded in the plugin package.
