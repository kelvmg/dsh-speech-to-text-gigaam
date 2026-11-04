"""Model-free regressions: python -m unittest discover -s test -p python_worker.py."""

import contextlib
import importlib.util
import io
import os
from pathlib import Path
import runpy
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np


WORKER_PATH = Path(__file__).resolve().parents[1] / "python" / "gigaam_stt.py"
spec = importlib.util.spec_from_file_location("gigaam_stt", WORKER_PATH)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class ChunkTests(unittest.TestCase):
    def assert_chunks(self, audio, maximum):
        cuts = worker._cut_points(audio, maximum)
        boundaries = [0, *cuts, len(audio)]
        lengths = np.diff(boundaries)
        self.assertTrue(np.all(lengths > 0))
        self.assertTrue(np.all(lengths <= int(min(maximum, 25) * worker.SR)))
        self.assertEqual(sum(lengths), len(audio))
        return cuts

    def test_silent_three_second_chunks_make_progress(self):
        self.assert_chunks(np.zeros(30 * worker.SR), 3)

    def test_twenty_six_seconds_requires_split_at_24_5(self):
        self.assertTrue(self.assert_chunks(np.zeros(26 * worker.SR), 24.5))

    def test_energy_search_cannot_exceed_maximum(self):
        audio = np.ones(60 * worker.SR, dtype=np.float32)
        audio[21 * worker.SR:23 * worker.SR] = 0
        self.assert_chunks(audio, 20)

    def test_exact_boundary_needs_no_split(self):
        self.assertEqual(worker._cut_points(np.zeros(3 * worker.SR), 3), [])

    def test_hard_model_limit_even_for_large_request(self):
        self.assert_chunks(np.ones(80 * worker.SR), 100)

    def test_non_frame_aligned_and_small_limits(self):
        for maximum in (0.0001, 0.01, 2.999, 3, 24.5):
            with self.subTest(maximum=maximum):
                self.assert_chunks(np.zeros(int(maximum * worker.SR) * 2 + 7), maximum)

    def test_invalid_limits_rejected(self):
        for maximum in (0, -1, float("nan"), float("inf")):
            with self.subTest(maximum=maximum), self.assertRaises(ValueError):
                worker._cut_points(np.zeros(100), maximum)

    def transcribe(self, audio, maximum, cuts=None):
        written = []
        calls = []

        def write(path, samples, sample_rate, subtype):
            self.assertEqual(sample_rate, worker.SR)
            self.assertEqual(subtype, "PCM_16")
            written.append(samples.copy())

        def recognize(path):
            calls.append(path)
            return SimpleNamespace(text=f" part{len(calls)} ")

        gigaam = SimpleNamespace(load_audio=lambda path: SimpleNamespace(numpy=lambda: audio))
        modules = {"gigaam": gigaam, "soundfile": SimpleNamespace(write=write)}
        with patch.dict(sys.modules, modules):
            if cuts is None:
                text = worker._transcribe_chunks(SimpleNamespace(transcribe=recognize), "input.wav", maximum)
            else:
                with patch.object(worker, "_cut_points", return_value=cuts):
                    text = worker._transcribe_chunks(SimpleNamespace(transcribe=recognize), "input.wav", maximum)
        return text, written, calls

    def test_transcription_preserves_every_sample_and_order(self):
        audio = np.arange(26 * worker.SR + 13, dtype=np.float32)
        text, written, calls = self.transcribe(audio, 24.5)
        self.assertGreater(len(calls), 1)
        np.testing.assert_array_equal(np.concatenate(written), audio)
        self.assertTrue(all(len(chunk) <= 24.5 * worker.SR for chunk in written))
        self.assertEqual(text, " ".join(f"part{i + 1}" for i in range(len(calls))))

    def test_sub_half_second_tail_is_not_dropped(self):
        audio = np.arange(3 * worker.SR + 1, dtype=np.float32)
        _, written, calls = self.transcribe(audio, 3, cuts=[3 * worker.SR])
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(written[-1]), 1)
        np.testing.assert_array_equal(np.concatenate(written), audio)

    def test_short_input_uses_original_file(self):
        _, written, calls = self.transcribe(np.zeros(worker.SR), 3)
        self.assertEqual(written, [])
        self.assertEqual(calls, ["input.wav"])

    def test_decoded_empty_audio_does_not_call_model(self):
        self.assertEqual(self.transcribe(np.zeros(0), 3), ("", [], []))


class EnvironmentTests(unittest.TestCase):
    def test_import_does_not_check_ffmpeg(self):
        with patch("shutil.which", side_effect=AssertionError("must not check on import")):
            runpy.run_path(str(WORKER_PATH), run_name="worker_import_test")

    def test_managed_bin_is_first_without_resolving_python(self):
        managed = os.path.join(os.sep, "managed", "venv", "bin")
        with patch.object(sys, "executable", os.path.join(managed, "python")), patch.dict(
            os.environ, {"PATH": os.pathsep.join(["/usr/bin", managed, "/bin"])}
        ):
            worker._extend_tool_path()
            parts = os.environ["PATH"].split(os.pathsep)
            self.assertEqual(parts[0], managed)
            self.assertEqual(parts.count(managed), 1)
            self.assertLess(parts.index(managed), parts.index("/usr/bin"))

    def test_warmup_without_ffmpeg(self):
        with patch.object(sys, "argv", [str(WORKER_PATH), "--warmup"]), patch.object(
            worker, "_require_ffmpeg", side_effect=AssertionError("not needed")
        ), patch.object(worker, "_load_gigaam", return_value=object()), patch.object(
            worker, "_load_model", return_value=(object(), "cpu")
        ), patch.object(worker, "_log"), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(worker.main(), 0)

    def test_empty_input_needs_neither_ffmpeg_nor_model(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "empty.wav"
            output = Path(directory) / "text.txt"
            source.write_bytes(b"\0" * 44)
            with patch.object(sys, "argv", [str(WORKER_PATH), "--input", str(source), "--output", str(output)]), patch.object(
                worker, "_require_ffmpeg", side_effect=AssertionError("not needed")
            ), patch.object(worker, "_load_gigaam", side_effect=AssertionError("not needed")):
                self.assertEqual(worker.main(), 0)
            self.assertEqual(output.read_text(), "")

    def test_real_transcription_checks_ffmpeg_before_model_load(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "audio.wav"
            source.write_bytes(b"\0" * 45)
            with patch.object(sys, "argv", [str(WORKER_PATH), "--input", str(source)]), patch.object(
                worker.shutil, "which", return_value=None
            ), patch.object(worker, "_load_gigaam", side_effect=AssertionError("must check tools first")):
                with self.assertRaisesRegex(SystemExit, "Prepare environment"):
                    worker.main()

    def test_missing_package_points_to_gui_preparation(self):
        with patch.dict(sys.modules, {"gigaam": None}):
            with self.assertRaisesRegex(SystemExit, "Prepare environment"):
                worker._load_gigaam()

    def test_traceback_uses_platform_temp_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "audio.wav"
            source.write_bytes(b"\0" * 45)
            with patch.object(sys, "argv", [str(WORKER_PATH), "--input", str(source)]), patch(
                "tempfile.gettempdir", return_value=directory
            ), patch("shutil.which", return_value="ffmpeg"), patch(
                "time.time", side_effect=RuntimeError("diagnostic sentinel")
            ):
                with self.assertRaisesRegex(RuntimeError, "diagnostic sentinel"):
                    runpy.run_path(str(WORKER_PATH), run_name="__main__")
            log = Path(directory) / "dsh-gigaam-stt.log"
            self.assertIn("diagnostic sentinel", log.read_text())
            self.assertIn("PATH=", log.read_text())


if __name__ == "__main__":
    unittest.main()
