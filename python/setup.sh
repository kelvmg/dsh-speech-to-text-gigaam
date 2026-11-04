#!/usr/bin/env bash
# Optional headless preparation. Normal users click Download and prepare in DSH.
# Node >=20.3 is required here; no system Python, Homebrew or git is needed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ "$#" -gt 0 ]; then
  echo 'Only v3_e2e_rnnt is supported by guided preparation; run without arguments.' >&2
  exit 2
fi
exec node "$HERE/../lib/setup-cli.js"
