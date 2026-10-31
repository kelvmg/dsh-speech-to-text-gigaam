# dsh-speech-to-text-gigaam

Local **Russian speech recognition for DeepSeek Harness voice input**, powered by
[Sber's GigaAM](https://github.com/salute-developers/GigaAM) and running entirely on
the Host CPU.

DSH ships a single recognizer — `sensevoice-local` (SenseVoiceSmall) — whose language
hints are `auto`, `zh`, `en`, `yue`, `ja`, `ko`: **no Russian**. This bundle registers
an additional `speechToText` provider, `gigaam-local`, and selects it as the default,
so the microphone button in the composer transcribes Russian with GigaAM v3
(e2e RNNT: punctuation and capitalisation included).

> Audio never leaves the machine. The only network access is the one-time download of
> model weights from Sber's public CDN during setup.

## Features

- **Russian-first quality.** GigaAM v3 is a state-of-the-art open ASR family for
  Russian; the e2e variant returns punctuated, capitalised text.
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
- About 450 MB for the model and 2.5 GB for the Python environment.

## Install

1. **Prepare the environment** (once). It creates a venv in
   `~/.dsh/speech-to-text/gigaam`, installs PyTorch and GigaAM, then downloads and
   warms up the model:

   ```bash
   ./python/setup.sh
   ```

   Override the location with `GIGAAM_DATA_ROOT=/path ./python/setup.sh`, and the
   model with `./python/setup.sh v3_e2e_ctc`.

2. **Install the bundle.** In the Harness UI: **Plugins → Add plugin**, paste the
   repository URL (`https://github.com/kelvmg/dsh-speech-to-text-gigaam`), this
   directory's absolute path, or the published package name — then **Install** and
   **Enable now**.

3. **Pick the recognizer.** Open the voice-input bundle details (or
   **Settings → voice input**), choose **GigaAM v3 (CPU)** and language `auto` or
   `ru`.

## Configuration

The bundle patch declares the row `speech-to-text-gigaam`:

| Key | Default | Meaning |
| --- | --- | --- |
| `dataRoot` | `~/.dsh/speech-to-text/gigaam` | Base directory for `venv/` and `models/` |
| `pythonPath` | `<dataRoot>/venv/bin/python` | Interpreter with `gigaam` installed |
| `scriptPath` | `<package>/python/gigaam_stt.py` | Worker script |
| `downloadRoot` | `<dataRoot>/models` | Model cache |
| `model` | `v3_e2e_rnnt` | See the model list below |
| `device` | `cpu` | `cpu`, `mps` or `cuda`; CPU is faster than MPS on Apple silicon |
| `maxChunkSeconds` | `20` | Chunk length for recordings over 25 s (clamped to 3–24.5) |
| `timeoutMs` | `900000` | Worker deadline, including the first model download |
| `providerId` | `gigaam-local` | Registered provider id |
| `languages` | `["auto","ru","en"]` | Language hints offered by the provider |

Available models: `v3_e2e_rnnt` (default, punctuation), `v3_e2e_ctc`,
`v3_rnnt`, `v3_ctc`, `multilingual_ctc`, `multilingual_large_ctc` and their
`_ssl` variants. Multilingual adds 70+ languages but is heavier; Russian quality is
best on the `v3` line.

## How it works

```
composer mic → speechToText service → gigaam-local provider (lib/index.js)
             → Python worker (python/gigaam_stt.py) → GigaAM on CPU → text
```

The provider spawns the interpreter per recording, so it is stateless; the model
loads in about 2 s and inference is roughly 0.04× real time on an M3.

## Performance (Apple M3, 8 cores, CPU)

| Recording | Wall time |
| --- | --- |
| 10.7 s | ~2.4 s |
| 39.5 s (2 chunks) | ~3.0 s |

## Limitations

- **No streaming.** The DSH speech service transcribes complete recordings only, so
  text appears after **Stop**, not while speaking.
- **One model instance at a time.** Recordings queue; each call reloads the model.
- **Russian-centric.** The `v3` line targets Russian; English is supported but
  weaker than Whisper-class models. Use the `multilingual_*` models for other
  languages.
- **CPU memory.** Expect roughly 1.5 GB RSS while a transcription runs.

## Troubleshooting

- `ffmpeg is required but was not found` — install ffmpeg or add its directory to
  `PATH`; the worker already prepends `/opt/homebrew/bin`, `/usr/local/bin` and
  `/opt/local/bin`.
- The worker writes diagnostic lines and full tracebacks to
  `<tmpdir>/dsh-gigaam-stt.log`, because the desktop app has no stderr console.
- `GigaAM worker failed to start … interpreter or script not found` — run
  `python/setup.sh` or point `pythonPath` at an existing environment.
- The first transcription downloads the model if `setup.sh` skipped the warm-up.

## Privacy

Recordings are written to a temporary directory, transcribed locally and deleted
immediately. No audio, transcript or telemetry is sent anywhere. Setup downloads
PyTorch wheels from your pip index and GigaAM weights from
`cdn.chatwm.opensmodel.sberdevices.ru`.

## License

MIT © 2026 Evgeny Klimov. GigaAM itself is MIT-licensed by SberDevices; see
[salute-developers/GigaAM](https://github.com/salute-developers/GigaAM).

## Changelog

- **0.2.0** — returns the `{ text, audioSeconds, inferenceSeconds }` result shape the
  voice API requires; portable defaults instead of absolute paths; `PATH` fix for
  GUI-launched apps; chunk-length clamping; smoke tests; package metadata.
- **0.1.0** — first working provider.
