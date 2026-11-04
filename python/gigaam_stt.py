#!/usr/bin/env python3
"""GigaAM CLI bridge for the DSH voice-input provider.

Reads a canonical 16 kHz mono PCM16 WAV recording, transcribes it with Sber's
GigaAM model, and writes plain text. The model accepts at most 25 s per call,
so longer recordings are cut at low-energy points near the target boundary and
the chunk transcripts are joined with spaces.

Usage:
    gigaam_stt.py --input voice.wav --output transcript.txt \
        [--model v3_e2e_rnnt] [--device cpu] [--max-chunk 20] [--download-root DIR]

    gigaam_stt.py --warmup --model v3_e2e_rnnt [--download-root DIR]
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
import time

import numpy as np


def _extend_tool_path() -> None:
    """Prefer the managed environment's ffmpeg, then local/system tools.

    Bootstrap places ffmpeg next to the venv Python executable. Do not resolve
    symlinks here: resolving Python may point outside that managed environment.
    """
    directories = [os.path.dirname(os.path.abspath(sys.executable))]
    directories.extend(
        directory for directory in ("/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin")
        if os.path.isdir(directory)
    )
    directories.extend(os.environ.get("PATH", "").split(os.pathsep))
    os.environ["PATH"] = os.pathsep.join(dict.fromkeys(part for part in directories if part))


_extend_tool_path()


def _require_ffmpeg() -> None:
    """Check only when audio decoding is needed, not during import or warmup."""
    if shutil.which("ffmpeg") is None:
        raise SystemExit(
            "ffmpeg was not found in the GigaAM environment. "
            "Open the plugin settings in DSH and run Prepare environment."
        )


SR = 16000
HARD_LIMIT_SEC = 25.0
MAX_CHUNK_SEC = 24.5
MIN_CHUNK_SEC = 3.0
DEFAULT_MODEL = "v3_e2e_rnnt"
LOG_PATH = os.path.join(tempfile.gettempdir(), "dsh-gigaam-stt.log")


def _log(message: str) -> None:
    """Append a diagnostic line; the desktop app has no stderr console."""
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n")
    except OSError:
        pass


def _pick_device(torch, requested: str) -> str:
    if requested and requested != "auto":
        return requested
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _frame_rms(audio: np.ndarray, frame: int = 320) -> np.ndarray:
    usable = len(audio) - (len(audio) % frame)
    if usable <= 0:
        return np.zeros(1, dtype=np.float32)
    frames = audio[:usable].reshape(-1, frame)
    return np.sqrt(np.mean(frames.astype(np.float32) ** 2, axis=1) + 1e-12)


def _cut_points(audio: np.ndarray, max_chunk: float) -> list[int]:
    """Return sample offsets that split *audio* into pieces of <= max_chunk seconds."""
    if not np.isfinite(max_chunk) or max_chunk <= 0:
        raise ValueError("max_chunk must be finite and positive")
    max_samples = max(1, int(min(max_chunk, HARD_LIMIT_SEC) * SR))
    total = len(audio)
    frame = 320  # 20 ms
    rms = _frame_rms(audio, frame)
    cuts: list[int] = []
    previous = 0
    while total - previous > max_samples:
        # Search only BEFORE the hard boundary, and strictly after the previous
        # cut. Searching on both sides can exceed the model limit or repeatedly
        # choose the same silent frame when max_chunk is as small as 3 seconds.
        boundary = previous + max_samples
        earliest = max(previous + min(2 * SR, max_samples), boundary - 3 * SR)
        lo = (earliest + frame - 1) // frame
        hi = min(boundary // frame, len(rms) - 1)
        cut = boundary
        if lo <= hi:
            cut = (lo + int(np.argmin(rms[lo:hi + 1]))) * frame
        cuts.append(cut)
        previous = cut
    return cuts


def _load_gigaam():
    try:
        import gigaam
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise SystemExit(
            "gigaam is not installed for this interpreter. "
            "Open the plugin settings in DSH and run Prepare environment."
        ) from exc
    return gigaam


def _transcribe_chunks(model, wav_path: str, max_chunk: float) -> str:
    import gigaam
    import soundfile as sf

    audio = gigaam.load_audio(wav_path).numpy()
    if not len(audio):
        return ""
    duration = len(audio) / SR
    if duration <= min(HARD_LIMIT_SEC, max_chunk):
        return model.transcribe(wav_path).text

    cuts = _cut_points(audio, max_chunk)
    boundaries = [0, *cuts, len(audio)]
    parts: list[str] = []
    with tempfile.TemporaryDirectory(prefix="gigaam-chunks-") as tmp:
        for index, (start, end) in enumerate(zip(boundaries, boundaries[1:])):
            chunk_path = os.path.join(tmp, f"chunk_{index:03d}.wav")
            sf.write(chunk_path, audio[start:end], SR, subtype="PCM_16")
            parts.append(model.transcribe(chunk_path).text.strip())
    return " ".join(part for part in parts if part)


def _load_model(gigaam, args):
    import torch

    device = _pick_device(torch, args.device)
    try:
        return gigaam.load_model(args.model, device=device, download_root=args.download_root), device
    except Exception as exc:  # MPS can reject Conformer ops; fall back to CPU
        if device != "cpu":
            print(f"device {device} failed ({exc}); retrying on cpu", file=sys.stderr)
            return gigaam.load_model(args.model, device="cpu", download_root=args.download_root), "cpu"
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--max-chunk", type=float, default=20.0)
    parser.add_argument("--download-root", default=None)
    parser.add_argument("--warmup", action="store_true", help="load the model and exit")
    parser.add_argument("--timing", action="store_true", help="print timings to stderr")
    args = parser.parse_args()

    requested_chunk = args.max_chunk
    args.max_chunk = min(MAX_CHUNK_SEC, max(MIN_CHUNK_SEC, args.max_chunk))
    if args.max_chunk != requested_chunk:
        print(
            f"max chunk {requested_chunk:g}s is outside the supported 3-24.5s range; using {args.max_chunk:g}s",
            file=sys.stderr,
        )

    if not args.warmup and not args.input:
        parser.error("--input is required unless --warmup is used")
    if args.input and not os.path.exists(args.input):
        print(f"input not found: {args.input}", file=sys.stderr)
        return 2
    if args.input and os.path.getsize(args.input) <= 44:
        # Silence/no samples: nothing to recognize.
        if args.output:
            open(args.output, "w", encoding="utf-8").close()
        return 0

    if not args.warmup:
        _require_ffmpeg()

    started = time.time()
    _log(f"start model={args.model} device={args.device} input={args.input or '-'} warmup={args.warmup}")
    gigaam = _load_gigaam()
    model, device = _load_model(gigaam, args)
    load_seconds = time.time() - started

    if args.warmup:
        print(f"ok: {args.model} loaded on {device} in {load_seconds:.2f}s")
        return 0

    text = _transcribe_chunks(model, args.input, args.max_chunk).strip()
    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(text + ("\n" if text else ""))
    print(text)

    _log(f"done chars={len(text)} seconds={time.time() - started:.2f}")
    if args.timing:
        print(
            f"[timing] device={device} load={load_seconds:.2f}s total={time.time() - started:.2f}s",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException:
        # The Host surfaces only the tail of stderr; keep the full trace for
        # diagnosis when voice input fails inside the desktop app.
        import traceback

        try:
            with open(LOG_PATH, "a", encoding="utf-8") as handle:
                handle.write(
                    f"\n--- {time.strftime('%Y-%m-%d %H:%M:%S')} argv={sys.argv[1:]}\n"
                    f"PATH={os.environ.get('PATH', '')}\n"
                )
                traceback.print_exc(file=handle)
        except OSError:
            pass
        raise
