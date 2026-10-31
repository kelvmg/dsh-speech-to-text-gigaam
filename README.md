# dsh-speech-to-text-gigaam

Local **Russian speech recognition for DeepSeek Harness voice input**, powered by
[Sber's GigaAM v3 E2E RNNT](https://github.com/salute-developers/GigaAM) and running
entirely on the Host CPU. Punctuation and capitalisation are part of the output.

DSH ships a single recognizer — `sensevoice-local` (SenseVoiceSmall) — whose language
hints are `auto`, `zh`, `en`, `yue`, `ja`, `ko`: **no Russian**. This bundle registers
an additional `speechToText` provider, `gigaam-local`, and selects it as the default.

> Audio never leaves the machine. The only network access is the one-time download of
> the model weights from Sber's public CDN.

## Features

- **Russian with punctuation.** GigaAM v3 E2E RNNT returns punctuated, capitalised
  text — no post-processing heuristics.
- **Guided download in the UI.** The provider never downloads on activation: the voice
  settings show an explicit “Download and prepare” card with disk, memory and time
  estimates, a progress bar, cancellation and checksum verification.
- **One model, no choices.** `v3_e2e_rnnt` is the only checkpoint the provider
  installs. Other GigaAM models can be pre-downloaded with `setup.sh` and selected in
  the row config, but the UI will not offer them.
- **Fully local.** No API keys, no cloud transcription; inference runs in a Python
  worker on the Host.
- **Long recordings.** GigaAM accepts at most 25 s per call; the worker cuts longer
  audio at low-energy points and joins the chunk transcripts.
- **Cancellable and serialized.** Cancel discards the recording and kills the worker;
  parallel recordings queue instead of loading several models at once.
- **Portable defaults.** Paths resolve to `~/.dsh/speech-to-text/gigaam`; no absolute
  paths are baked into the bundle.

## Requirements

- DeepSeek Harness with the voice-input bundle (`@deepseek-ai/dsh-experimental-voice-input-bundle`).
- `ffmpeg` on `PATH` (`brew install ffmpeg`).
- Python 3.10+ with `torch`, `torchaudio` and `gigaam` — `python/setup.sh` builds it.
- About 430 MB for the model and 2.5 GB for the Python environment.

## Install

1. **Prepare the Python environment** (once). It creates a venv in
   `~/.dsh/speech-to-text/gigaam`, installs PyTorch and GigaAM, then downloads and
   warms up the model:

   ```bash
   ./python/setup.sh
   ```

   Override the location with `GIGAAM_DATA_ROOT=/path ./python/setup.sh`. The model is
   optional here: if the script is run without network access, the UI can download it
   later.

2. **Install the bundle.** In the Harness UI: **Plugins → Add plugin**, paste the
   repository URL (`https://github.com/kelvmg/dsh-speech-to-text-gigaam`), this
   directory's absolute path, or the published package name — then **Install** and
   **Enable now**.

3. **Pick the recognizer.** Open the voice-input bundle details (or
   **Settings → voice input**), choose **GigaAM v3 · Russian (punctuation)** and
   language `auto` or `ru`.

## Guided model download

On activation the provider only inspects the cache. With no model on disk it reports
`unprepared`, and the voice settings show a card with:

| Estimate | Value |
| --- | --- |
| Disk | ~0.5 GB |
| Memory | ~1.5 GB |
| Time | 1–5 minutes |

“Download and prepare” then runs four steps:

1. **Check local resources** — the Python interpreter and the worker script exist.
2. **Prepare recognition model** — downloads `v3_e2e_rnnt.ckpt` (428 MB) and
   `v3_e2e_rnnt_tokenizer.model` (0.25 MB) from
   `https://cdn.chatwm.opensmodel.sberdevices.ru` into `downloadRoot`.
3. **Verify model files** — size, MD5 of the checkpoint
   (`2730de7545ac43ad256485a462b0a27a`) and SHA-256 of the tokenizer.
4. **Load GigaAM v3 · Russian (punctuation)** — a warm-up run, so the first dictation
   takes seconds instead of half a minute.

The download can be cancelled at any point; a partial file is removed and the next
attempt starts over. On success the provider reports `standby`/`ready` and the
microphone records normally.

If the interpreter is missing, the card reports a failure with the instruction to run
`python/setup.sh` — nothing is downloaded or recorded in that state.

## Configuration

The bundle patch declares the row `speech-to-text-gigaam`:

| Key | Default | Meaning |
| --- | --- | --- |
| `dataRoot` | `~/.dsh/speech-to-text/gigaam` | Base directory for `venv/` and `models/` |
| `pythonPath` | `<dataRoot>/venv/bin/python` | Interpreter with `gigaam` installed |
| `scriptPath` | `<package>/python/gigaam_stt.py` | Worker script |
| `downloadRoot` | `<dataRoot>/models` | Model cache |
| `model` | `v3_e2e_rnnt` | Only this model is offered for guided download |
| `device` | `cpu` | `cpu`, `mps` or `cuda`; CPU is faster than MPS on Apple silicon |
| `maxChunkSeconds` | `20` | Chunk length for recordings over 25 s (clamped to 3–24.5) |
| `timeoutMs` | `900000` | Worker deadline, including the first model download |
| `providerId` | `gigaam-local` | Registered provider id |
| `providerName` | `GigaAM v3 · Russian (punctuation)` | Label in the provider list |
| `downloadSources` | CDN Sber | Origins offered for the download |
| `loadModel` | `true` | Skip the warm-up step (tests) |

## How it works

```
composer mic → speechToText service → gigaam-local provider (lib/index.js)
             → preparation (lib/preparation.js) for the model files
             → Python worker (python/gigaam_stt.py) → GigaAM on CPU → text
```

The worker is spawned per recording, so the provider is stateless; the model loads in
about 2 s and inference is roughly 0.04× real time on an M3.

## Performance (Apple M3, 8 cores, CPU)

| Recording | Wall time |
| --- | --- |
| 10.7 s | ~3 s |
| 39.5 s (2 chunks) | ~3 s |
| Warm-up (verify + load) | ~3 s |

## Limitations

- **One model.** Only `v3_e2e_rnnt` is downloadable from the UI. Other GigaAM models
  (multilingual, CTC, SSL) must be fetched manually and referenced in the config.
- **No streaming.** The DSH speech service transcribes complete recordings only, so
  text appears after **Stop**.
- **Python environment is scripted.** `prepare()` downloads weights, but the 2.5 GB
  Python environment still comes from `python/setup.sh`.
- **CPU memory.** Expect roughly 1.5 GB RSS while a transcription runs.

## Troubleshooting

- `ffmpeg is required but was not found` — install ffmpeg; the worker prepends
  `/opt/homebrew/bin`, `/usr/local/bin` and `/opt/local/bin` to `PATH` already.
- `Python environment not found … Run python/setup.sh first` — the venv is missing or
  `pythonPath` points elsewhere.
- `Downloaded … failed its checksum; try again` — a proxy or mirror returned corrupted
  bytes; the partial file is removed, retry the download.
- The worker writes diagnostic lines and full tracebacks to
  `<tmpdir>/dsh-gigaam-stt.log`, because the desktop app has no stderr console.

## Privacy

Recordings are written to a temporary directory, transcribed locally and deleted
immediately. No audio, transcript or telemetry is sent anywhere. Setup downloads
PyTorch wheels from your pip index and GigaAM weights from
`cdn.chatwm.opensmodel.sberdevices.ru`.

## License

MIT © 2026 Evgeny Klimov. GigaAM itself is MIT-licensed by SberDevices; see
[salute-developers/GigaAM](https://github.com/salute-developers/GigaAM).

## Changelog

- **0.3.0** — guided model download with progress, cancellation and checksum
  verification; explicit setup card; single-model scope (`v3_e2e_rnnt`); preparation
  unit tests.
- **0.2.0** — returns the `{ text, audioSeconds, inferenceSeconds }` result shape the
  voice API requires; portable defaults instead of absolute paths; `PATH` fix for
  GUI-launched apps; chunk-length clamping; smoke tests; package metadata.
- **0.1.0** — first working provider.
