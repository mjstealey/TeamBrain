#!/bin/sh
# TeamBrain client-commands installer.
#
# Fetches the TeamBrain slash-command (Claude Code) / skill (Codex) / command
# (Cursor) files and writes them into the CURRENT repo. They are credential-free
# prompt templates over the already-connected `teambrain` MCP server — connect
# the MCP first (https://pr.fabric-testbed.net/help), or they have nothing to
# call. No TeamBrain checkout required.
#
# Usage (run from your repo root):
#   curl -fsSL https://pr.fabric-testbed.net/install.sh | sh
#   curl -fsSL https://pr.fabric-testbed.net/install.sh | sh -s -- --client claude-code
#   curl -fsSL https://pr.fabric-testbed.net/install.sh | sh -s -- --list
#
# Options:
#   --client <id>   claude-code | codex | cursor | all   (default: all)
#   --ref <ref>     git ref to pull from                 (default: main)
#   --dest <dir>    target repo root                     (default: git toplevel, else .)
#   --list          print what would be installed, write nothing
#   -h, --help      this help
#
# The authoritative file list is install/manifest.json (what the
# get_client_commands MCP tool serves). This script derives the same set from
# the stable tb-<action> naming convention; keep NAMES in sync if that changes.

set -u

# Public mirror — origin fabric-testbed/TeamBrain is private, so GitHub raw only
# serves the mjstealey/TeamBrain mirror (kept current by the post-merge push).
REPO="mjstealey/TeamBrain"
REF="main"
CLIENT="all"
DEST=""
LIST=0
NAMES="remember recall recent"

usage() {
  cat <<'EOF'
TeamBrain client-commands installer. Run from your repo root.

  curl -fsSL https://pr.fabric-testbed.net/install.sh | sh
  curl -fsSL https://pr.fabric-testbed.net/install.sh | sh -s -- --client claude-code

Options:
  --client <id>   claude-code | codex | cursor | all   (default: all)
  --ref <ref>     git ref to pull from                 (default: main)
  --dest <dir>    target repo root                     (default: git toplevel, else .)
  --list          print what would be installed, write nothing
  -h, --help      this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --client) CLIENT="${2:-}"; shift 2 ;;
    --client=*) CLIENT="${1#*=}"; shift ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --ref=*) REF="${1#*=}"; shift ;;
    --dest) DEST="${2:-}"; shift 2 ;;
    --dest=*) DEST="${1#*=}"; shift ;;
    --list) LIST=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$CLIENT" in
  claude-code|codex|cursor|all) ;;
  *) echo "invalid --client '$CLIENT' (use claude-code, codex, cursor, or all)" >&2; exit 2 ;;
esac

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }

if [ -z "$DEST" ]; then
  DEST=$(git rev-parse --show-toplevel 2>/dev/null) || DEST="."
fi

RAW="https://raw.githubusercontent.com/$REPO/$REF"
FAILED=0

want() { [ "$CLIENT" = "all" ] || [ "$CLIENT" = "$1" ]; }

install_file() { # src dest
  _dst="$DEST/$2"
  if [ "$LIST" -eq 1 ]; then echo "  $2"; return 0; fi
  mkdir -p "$(dirname "$_dst")" || { FAILED=1; return 1; }
  _tmp="$_dst.tbdl.$$"
  if curl -fsSL "$RAW/$1" -o "$_tmp"; then
    mv "$_tmp" "$_dst"
    echo "  ok  $2"
  else
    rm -f "$_tmp"
    echo "  ERR $2  (fetch failed: $RAW/$1)" >&2
    FAILED=1
  fi
}

echo "TeamBrain commands -> $DEST  (ref: $REF)"

if want claude-code; then
  echo "Claude Code  (.claude/commands/):"
  for nm in $NAMES; do install_file ".claude/commands/tb-$nm.md" ".claude/commands/tb-$nm.md"; done
fi
if want codex; then
  echo "Codex skills (.agents/skills/):"
  for nm in $NAMES; do install_file ".agents/skills/tb-$nm/SKILL.md" ".agents/skills/tb-$nm/SKILL.md"; done
fi
if want cursor; then
  echo "Cursor       (.cursor/commands/ — community, untested):"
  for nm in $NAMES; do install_file "examples/slash-commands/cursor/tb-$nm.md" ".cursor/commands/tb-$nm.md"; done
fi

if [ "$LIST" -eq 1 ]; then exit 0; fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "Done. These call the 'teambrain' MCP server — connect it first if you haven't:"
  echo "  https://pr.fabric-testbed.net/help"
else
  echo "Finished with errors (see ERR lines above)." >&2
fi
exit "$FAILED"
