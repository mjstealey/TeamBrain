# context: TODO (future session): round out AGENTS.md § "How to connect" so the connect sta

> Promoted from TeamBrain thought `5fc671cf-721e-4ec7-a37c-ef6c97fd1e5f` on 2026-06-16T10:57:24.775Z.

## Content

TODO (future session): round out AGENTS.md § "How to connect" so the connect stanzas cover every client the file's header promises.

The header advertises orientation for **Claude Code, Cursor, gemini-cli, Copilot, ChatGPT**, but § "How to connect" currently only documents **Claude Code** (`claude mcp add ...`) and **Codex** (`~/.codex/config.toml`). Missing stanzas to add:
- **Cursor** — `.cursor/mcp.json`
- **gemini-cli** — its own MCP config mechanism
- **Copilot / VS Code** — `.vscode/mcp.json` or settings
- **ChatGPT / generic custom client** — note (no repo-config concept; connect via the client's own MCP/remote-tool config using the same URL + bearer JWT)

All stanzas use the same doorway already documented: remote HTTP MCP at `https://pr.fabric-testbed.net/functions/v1/teambrain-mcp` + `Authorization: Bearer <24h GitHub-OAuth JWT>` from the landing page.

**Blocker (why this is deferred):** Michael needs to set up real accounts with each provider first, so each new stanza can be **smoke-tested end-to-end before committing** — do not ship untested connect instructions into a human-owned file. Until accounts exist, this stays a TODO.

Context for why we did NOT instead commit a `.mcp.json`: that file is primarily a Claude Code convention, so committing it would privilege one client over the others AGENTS.md treats as equals — against the AI-agnostic thesis. The tool-neutral AGENTS.md "How to connect" prose is the correct single doorway; this TODO just completes its client coverage. (AGENTS.md is human-owned — propose edits via PR, don't silently rewrite.)

## Provenance

- scope: `project`
- captured: 2026-06-01T20:03:43.528792+00:00
- last verified: 2026-06-15T12:33:02.834+00:00
- paths: `AGENTS.md`
- tags: `todo`, `agents-md`, `onboarding`, `mcp-connect`
