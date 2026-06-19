// teambrain-mcp/client-commands.ts — hand a connected agent the TeamBrain
// slash-command / Codex-skill / Cursor-command files so it can INSTALL them into
// the current repo, instead of crawling the TeamBrain source to reconstruct them.
//
// Single source of truth: the public mirror mjstealey/TeamBrain (the canonical
// origin fabric-testbed/TeamBrain is PRIVATE, so unauthenticated GitHub raw 404s
// there). The mirror tracks main via the established post-merge `git push
// personal main` workflow. We fetch the manifest (install/manifest.json) and each
// listed file from GitHub raw at request time, so the result matches the requested
// ref (default `main`) and nothing is duplicated into this function bundle. The
// files are credential-free prompt templates over the already-connected
// `teambrain` MCP server — nothing sensitive to gate beyond the endpoint's JWT.

const REPO = 'mjstealey/TeamBrain';

export class ClientCommandsError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ClientCommandsError';
  }
}

export type ClientId = 'claude-code' | 'codex' | 'cursor' | 'all';

interface ManifestFile { src: string; dest: string }
interface ManifestClient { id: string; label?: string; untested?: boolean; files: ManifestFile[] }
interface Manifest { repo?: string; ref?: string; note?: string; clients: ManifestClient[] }

function rawUrl(ref: string, path: string): string {
  return `https://raw.githubusercontent.com/${REPO}/${ref}/${path}`;
}

export async function getClientCommands(
  opts: { client?: ClientId; ref?: string },
): Promise<{
  repo: string;
  ref: string;
  note: string | null;
  instructions: string;
  count: number;
  files: { client: string; dest: string; content: string; untested: boolean }[];
}> {
  const ref    = (opts.ref ?? 'main').trim() || 'main';
  const client = opts.client ?? 'all';

  // 1. Manifest — the authoritative file list.
  const manUrl = rawUrl(ref, 'install/manifest.json');
  let manifest: Manifest;
  try {
    const r = await fetch(manUrl, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new ClientCommandsError(`manifest fetch returned ${r.status} (${manUrl})`);
    manifest = await r.json() as Manifest;
  } catch (e) {
    if (e instanceof ClientCommandsError) throw e;
    throw new ClientCommandsError(`could not fetch manifest at ${manUrl}: ${(e as Error).message}`);
  }
  if (!manifest?.clients?.length) {
    throw new ClientCommandsError(`manifest at ${manUrl} has no clients`);
  }

  const clients = manifest.clients.filter((c) => client === 'all' || c.id === client);
  if (clients.length === 0) {
    throw new ClientCommandsError(
      `unknown client "${client}". Available: ${manifest.clients.map((c) => c.id).join(', ')}, all`,
    );
  }

  // 2. File contents, fetched in parallel.
  const jobs = clients.flatMap((c) =>
    c.files.map(async (f) => {
      const url = rawUrl(ref, f.src);
      const r = await fetch(url);
      if (!r.ok) throw new ClientCommandsError(`file fetch returned ${r.status} (${url})`);
      return { client: c.id, dest: f.dest, content: await r.text(), untested: c.untested === true };
    })
  );

  let files;
  try {
    files = await Promise.all(jobs);
  } catch (e) {
    if (e instanceof ClientCommandsError) throw e;
    throw new ClientCommandsError(`could not fetch command files: ${(e as Error).message}`);
  }

  return {
    repo: REPO,
    ref,
    note: manifest.note ?? null,
    instructions:
      'Write each file to its `dest` path relative to the current repo root, ' +
      'creating parent directories as needed. These are credential-free prompt ' +
      'templates; the `teambrain` MCP server must already be connected for them to work.',
    count: files.length,
    files,
  };
}
