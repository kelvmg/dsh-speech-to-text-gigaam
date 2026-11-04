import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { release as osRelease } from "node:os";
import { downloadVerified, verifyFile } from "./download.js";
import { runProcess } from "./process.js";
import { DEPENDENCY_LOCK, GIGAAM_SOURCE, PYTHON_VERSION, REQUIREMENTS, RUNTIME_VERSION, UV_ARCHIVES } from "./runtime-manifest.js";
import { PACKAGE_DIR } from "./config.js";

const PROBE = "import torch, torchaudio, gigaam, soundfile, imageio_ffmpeg; import subprocess, sys, os; subprocess.run([os.path.join(os.path.dirname(sys.executable), 'ffmpeg'), '-version'], check=True, stdout=subprocess.DEVNULL)";
const INSTALL_FFMPEG = "import imageio_ffmpeg, os, shutil, sys; p=os.path.join(os.path.dirname(sys.executable), 'ffmpeg'); shutil.copyfile(imageio_ffmpeg.get_ffmpeg_exe(), p); os.chmod(p, 0o755)";

/** Downloads only after an explicit prepare request; never touches system Python/PATH. */
export class RuntimeManager {
  constructor(config, { platform = `${process.platform}-${process.arch}`, run = runProcess, download = downloadVerified } = {}) {
    this.config = config;
    this.platform = platform;
    this.run = run;
    this.download = download;
    this.root = join(config.dataRoot, "runtime");
    this.marker = join(this.root, "ready.json");
    this.fingerprint = createHash("sha256").update(JSON.stringify({ RUNTIME_VERSION, PYTHON_VERSION, REQUIREMENTS, DEPENDENCY_LOCK, GIGAAM_SOURCE, platform, python: config.pythonPath })).digest("hex");
  }

  supported() {
    return Boolean(UV_ARCHIVES[this.platform]) &&
      !(process.platform === "darwin" && Number(osRelease().split(".")[0]) < 22);
  }

  async isReady() {
    try {
      await access(this.config.pythonPath, constants.X_OK);
      if (!this.config.manageRuntime) return true;
      const marker = JSON.parse(await readFile(this.marker, "utf8"));
      await access(join(this.root, "venv", "bin", "ffmpeg"), constants.X_OK);
      return marker.fingerprint === this.fingerprint;
    } catch { return false; }
  }

  async withLock(operation, signal) {
    await mkdir(this.config.dataRoot, { recursive: true });
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    combined.throwIfAborted();
    let compromised;
    let release;
    try {
      release = await lockfile.lock(this.config.dataRoot, {
        realpath: true, lockfilePath: join(this.config.dataRoot, ".prepare.lock"),
        stale: 120_000, update: 10_000, retries: 0,
        onCompromised: (error) => { compromised = error; controller.abort(error); },
      });
    } catch (error) {
      if (error.code === "ELOCKED") throw new Error("GigaAM is already being prepared in another session. Wait or cancel it there. After a crash, retry in two minutes.");
      throw error;
    }
    try {
      combined.throwIfAborted();
      const result = await operation(combined);
      if (compromised) throw compromised;
      return result;
    } finally {
      try { await release(); } catch (error) { if (!compromised) throw error; }
    }
  }

  async ensure(signal, notify = () => {}) {
    signal.throwIfAborted();
    if (!this.config.manageRuntime) {
      await access(this.config.pythonPath, constants.X_OK);
      return;
    }
    if (!this.supported()) {
      throw new Error(`Automatic GigaAM setup is not yet supported on ${this.platform}. This release supports macOS 13+ on Apple Silicon. A custom pythonPath can use an externally prepared environment.`);
    }
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith("UV_") && !key.startsWith("PIP_") && !["PYTHONPATH", "PYTHONHOME", "IMAGEIO_FFMPEG_EXE"].includes(key)));
    const env = {
      ...inherited,
      UV_PYTHON_INSTALL_DIR: join(this.root, "python"),
      UV_CACHE_DIR: join(this.root, "cache"),
      UV_PYTHON_BIN_DIR: join(this.root, "tools"),
      UV_LINK_MODE: "copy", UV_PYTHON_PREFERENCE: "only-managed", UV_NO_CONFIG: "1",
      PYTHONNOUSERSITE: "1", PYTHONUNBUFFERED: "1",
      TMPDIR: join(this.root, "tmp"),
    };
    const lockPath = join(PACKAGE_DIR, "python", DEPENDENCY_LOCK.name);
    if (!(await verifyFile(lockPath, DEPENDENCY_LOCK, signal))) throw new Error("Bundled dependency lockfile failed verification. Reinstall the GigaAM plugin.");
    const run = (command, args) => this.run(command, args, { signal, env, timeoutMs: this.config.setupTimeoutMs });
    if (await this.isReady()) {
      try { await run(this.config.pythonPath, ["-I", "-c", PROBE]); return; }
      catch (error) { signal.throwIfAborted(); await rm(this.marker, { force: true }); }
    }
    await mkdir(join(this.root, "tools"), { recursive: true });
    await mkdir(join(this.root, "tmp"), { recursive: true });
    await rm(this.marker, { force: true });
    const uvArchive = UV_ARCHIVES[this.platform];
    const uvPath = join(this.root, "tools", "uv");
    const archivePath = join(this.root, uvArchive.name);
    notify({ resource: "Downloading isolated Python installer" });
    if (!(await verifyFile(archivePath, uvArchive, signal))) {
      await this.download(uvArchive, archivePath, {
        signal, timeoutMs: this.config.setupTimeoutMs,
        onProgress: (completedBytes, totalBytes) => notify({ resource: "Isolated Python installer", completedBytes, totalBytes }),
      });
    }
    // Re-extract the verified archive, never trust an executable left by a failed setup.
    await run("/usr/bin/tar", ["-xzf", archivePath, "-C", join(this.root, "tools"), "--strip-components=1"]);
    await chmod(uvPath, 0o755);
    notify({ resource: `Installing isolated Python ${PYTHON_VERSION}` });
    await run(uvPath, ["python", "install", PYTHON_VERSION]);
    notify({ resource: "Creating isolated recognition environment" });
    await run(uvPath, ["venv", "--python", PYTHON_VERSION, "--allow-existing", join(this.root, "venv")]);
    const sourcePath = join(this.root, GIGAAM_SOURCE.name);
    if (!(await verifyFile(sourcePath, GIGAAM_SOURCE, signal))) {
      await this.download(GIGAAM_SOURCE, sourcePath, {
        signal, timeoutMs: this.config.setupTimeoutMs,
        onProgress: (completedBytes, totalBytes) => notify({ resource: "GigaAM library", completedBytes, totalBytes }),
      });
    }
    notify({ resource: "Installing PyTorch, GigaAM and bundled audio tools (this can take several minutes)" });
    const pip = ["pip", "install", "--reinstall", "--python", this.config.pythonPath, "--index-url", "https://pypi.org/simple"];
    await run(uvPath, [...pip, "--require-hashes", "-r", lockPath]);
    await run(uvPath, [...pip, "--no-deps", sourcePath]);
    notify({ resource: "Checking recognition environment" });
    await run(this.config.pythonPath, ["-I", "-c", INSTALL_FFMPEG]);
    await run(this.config.pythonPath, ["-I", "-c", PROBE]);
    signal.throwIfAborted();
    const temporary = `${this.marker}.tmp`;
    await writeFile(temporary, JSON.stringify({ fingerprint: this.fingerprint, python: PYTHON_VERSION, platform: this.platform }), { mode: 0o600 });
    await rename(temporary, this.marker);
  }
}
