#!/usr/bin/env bash
# scripts/deno-check.sh — type-check every edge function before deploy.
#
# WHY THIS EXISTS: the Supabase Edge Runtime ships whatever is in
# volumes/functions/ WITHOUT a type-check pass, so a latent TypeScript error
# reaches production unnoticed (it only shows up as a runtime surprise later).
# Run this before any edge-function deploy. It uses a throwaway denoland/deno
# container so no local Deno install is required.
#
# Usage:
#   scripts/deno-check.sh            # check all edge-functions/*/index.ts
#   scripts/deno-check.sh teambrain-mcp teambrain-rest   # check a subset
#
# Exit non-zero if any function fails `deno check`.

set -euo pipefail

# Repo root = parent of this script's dir, so it runs from anywhere.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FUNCS_DIR="${ROOT}/edge-functions"
IMAGE="denoland/deno:latest"

# Targets: explicit args, or every directory under edge-functions/ that has an
# index.ts.
if [[ $# -gt 0 ]]; then
  targets=("$@")
else
  targets=()
  for d in "${FUNCS_DIR}"/*/; do
    [[ -f "${d}index.ts" ]] && targets+=("$(basename "$d")")
  done
fi

failed=()
for fn in "${targets[@]}"; do
  if [[ ! -f "${FUNCS_DIR}/${fn}/index.ts" ]]; then
    echo "skip ${fn}: no index.ts"
    continue
  fi
  echo "==> deno check ${fn}/index.ts"
  if docker run --rm -v "${FUNCS_DIR}:/work" -w /work "${IMAGE}" \
       deno check "${fn}/index.ts"; then
    echo "    ok"
  else
    echo "    FAILED"
    failed+=("${fn}")
  fi
done

if [[ ${#failed[@]} -gt 0 ]]; then
  echo
  echo "deno check FAILED for: ${failed[*]}"
  exit 1
fi
echo
echo "all functions type-check clean"
