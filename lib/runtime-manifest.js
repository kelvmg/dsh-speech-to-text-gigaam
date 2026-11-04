/** Release-pinned bootstrap inputs. New platforms require a clean-install test. */
export const RUNTIME_VERSION = "1";
export const DEPENDENCY_LOCK = {
  name: "requirements-macos-arm64.lock", bytes: 54990,
  sha256: "82db3782798bb26e99295f151d0baf57ed430ae99995fb62bb8ef3e98ff0726a",
};
export const PYTHON_VERSION = "3.11.14";
export const UV_VERSION = "0.9.7";
export const UV_ARCHIVES = {
  "darwin-arm64": {
    name: "uv-aarch64-apple-darwin.tar.gz",
    url: "https://github.com/astral-sh/uv/releases/download/0.9.7/uv-aarch64-apple-darwin.tar.gz",
    bytes: 18372336,
    sha256: "35572b9619fc14d67fc1cd72582c3cfc5c9c66d97f310192e04f26fb3fe96005",
  },
};
export const GIGAAM_SOURCE = {
  name: "gigaam-7447938d791c4f3e643386ee22c33777004293a5.tar.gz",
  url: "https://codeload.github.com/salute-developers/GigaAM/tar.gz/7447938d791c4f3e643386ee22c33777004293a5",
  bytes: 592675,
  sha256: "6ff116580aebee5f4b32d62ed7938e30004815caf85fcbbc301d5b9b3f001d3f",
};
export const REQUIREMENTS = [
  "torch==2.8.0", "torchaudio==2.8.0", "numpy==2.2.6",
  "hydra-core==1.3.2", "omegaconf==2.3.0", "sentencepiece==0.2.1",
  "soundfile==0.13.1", "tqdm==4.67.1", "imageio-ffmpeg==0.6.0",
  "onnx==1.19.1", "onnxruntime==1.23.2",
];
