#!/usr/bin/env bash
# scripts/check-embedded-assets.sh — fail if the base64 assets embedded in
# edge-functions/teambrain-console/agents-md.ts have drifted from their
# on-disk sources.
#
# WHY: agents-md.ts embeds two repo files as base64 constants (the
# capture-on-merge workflow and the AGENTS.md template) because edge functions
# can't read repo files at runtime, and template literals can't hold their
# backticks / ${{ }} sequences. If someone edits the source file but not the
# constant (or vice-versa), the dashboard would commit a stale workflow /
# template. This check catches that drift in CI / before deploy.
#
# Usage: scripts/check-embedded-assets.sh   (exit 0 = in sync, 1 = drift)

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 - "$ROOT" <<'PY'
import base64, re, sys, pathlib
root = pathlib.Path(sys.argv[1])
ts = (root / "edge-functions/teambrain-console/agents-md.ts").read_text()

assets = {
    "CAPTURE_ON_MERGE_YML_B64": "examples/github-actions/capture-on-merge.yml",
    "AGENTS_MD_TEMPLATE_B64":   "docs/AGENTS.md.template",
}

drift = []
for const, rel in assets.items():
    m = re.search(r"const " + const + r" =\s*\n?\s*'([^']*)';", ts)
    if not m:
        drift.append(f"{const}: constant not found in agents-md.ts")
        continue
    embedded = base64.b64decode(m.group(1))
    on_disk = (root / rel).read_bytes()
    if embedded == on_disk:
        print(f"ok   {const} == {rel} ({len(on_disk)} bytes)")
    else:
        drift.append(f"{const} != {rel} (embedded {len(embedded)}B vs on-disk {len(on_disk)}B)")

# Guard the live dogfood workflow against drifting from the template that gets
# embedded. That exact drift (examples/ left behind when .github/workflows/ got
# a fix) once shipped a stale capture-on-merge via the dashboard's setup-pr.
live = root / ".github/workflows/capture-on-merge.yml"
tmpl = root / "examples/github-actions/capture-on-merge.yml"
if live.read_bytes() == tmpl.read_bytes():
    print("ok   .github/workflows/capture-on-merge.yml == examples/github-actions/capture-on-merge.yml")
else:
    drift.append(".github/workflows/capture-on-merge.yml != examples/github-actions/capture-on-merge.yml "
                 "(live workflow drifted from the template that gets embedded)")

if drift:
    print("\nDRIFT DETECTED:", file=sys.stderr)
    for d in drift:
        print("  - " + d, file=sys.stderr)
    print("\nRe-embed with:", file=sys.stderr)
    print("  base64 < <source-file> | tr -d '\\n'   # paste into the constant", file=sys.stderr)
    sys.exit(1)
print("\nembedded assets in sync")
PY
