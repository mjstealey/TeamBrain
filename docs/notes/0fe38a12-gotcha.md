# gotcha: **Correction to § D milestone `bb09c82f` — Codex slash commands ship as SKILLS, 

> Promoted from TeamBrain thought `0fe38a12-14d8-45ce-a93f-823ae3259871` on 2026-06-15T12:30:55.146Z.

## Content

**Correction to § D milestone `bb09c82f` — Codex slash commands ship as SKILLS, not custom prompts (2026-06-09).**

The § D milestone thought `bb09c82f` says the Codex variant installs to `~/.codex/prompts/` as custom prompts. That's superseded: **Codex custom prompts are deprecated** in favor of **skills** (https://developers.openai.com/codex/custom-prompts → https://developers.openai.com/codex/skills).

What changed in the same PR (#23, commit `42098dc`):
- Codex commands now ship as committed **skills** at `.agents/skills/{tb-remember,tb-recall,tb-recent}/SKILL.md` (each a dir with a `SKILL.md`; `name` + `description` frontmatter).
- Skills are **repo-discovered** from `$REPO_ROOT/.agents/skills/` (also `~/.agents/skills/` user-level, `/etc/codex/skills` admin) — so, unlike the old home-dir prompts, they're committed and team-shared with **no per-developer install**, at parity with Claude Code's `.claude/commands/`.
- The deprecated `examples/slash-commands/codex/*.md` custom-prompt templates were removed.

Gotchas worth knowing for Codex skills: (1) no `$ARGUMENTS` placeholder — a skill is instructions and the user's surrounding message supplies the specifics; (2) skills live under `.agents/skills/`, **not** `.codex/skills/` (so the repo's `.codex/` gitignore doesn't touch them, and `.agents/` isn't ignored); (3) invoke via `/skills` or `$`-mention, or Codex triggers them implicitly from the `description`. Cursor is unchanged (copy-anywhere template, untested).

## Provenance

- scope: `project`
- captured: 2026-06-09T16:55:58.091628+00:00
- paths: `.agents/skills/tb-remember/SKILL.md`, `.agents/skills/tb-recall/SKILL.md`, `.agents/skills/tb-recent/SKILL.md`, `examples/slash-commands/README.md`
- tags: `phase-5`, `slash-commands`, `codex`, `skills`, `correction`, `deprecation`, `agents-skills`
