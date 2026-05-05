// embedding.ts — pluggable embedding provider.
//
// ADR 0001 § Decision 5: TeamBrain supports multiple embedding backends,
// chosen at deploy time via the EMBEDDING_PROVIDER env var. Each
// deployment picks one and lives with it — pgvector column dimension
// is fixed at table-create time, so the schema must match the provider's
// output dim. See `migrations/0001_init.sql` (default 1536) and
// `migrations/0005_resize_embedding_768.sql` (optional 768-dim variant
// for ollama / nomic-embed-text-style self-hosted deployments).
//
// Required env vars:
//   EMBEDDING_PROVIDER  — 'openai' (default) | 'ollama'
//   EMBEDDING_DIMS      — expected output dim, used as runtime sanity check
//                         (must match the column type in the deployed schema)
// Provider-specific:
//   openai: OPENAI_API_KEY, optional OPENAI_EMBEDDING_MODEL (default
//           'text-embedding-3-small')
//   ollama: OLLAMA_URL (e.g. 'http://ollama:11434'), optional
//           OLLAMA_EMBEDDING_MODEL (default 'nomic-embed-text')
//
// Adding a new provider: add a case to the switch in `embed()` and a
// matching `embedFooBar()` implementation. Schema migration is the
// deploying team's responsibility; this file does not own that.

const PROVIDER       = (Deno.env.get('EMBEDDING_PROVIDER') ?? 'openai').toLowerCase();
const EXPECTED_DIMS  = Number(Deno.env.get('EMBEDDING_DIMS') ?? '1536');

if (!Number.isFinite(EXPECTED_DIMS) || EXPECTED_DIMS <= 0) {
  console.error(`embedding: EMBEDDING_DIMS=${Deno.env.get('EMBEDDING_DIMS')} is not a positive integer`);
}

export class EmbeddingError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

export async function embed(text: string): Promise<number[]> {
  if (!text || !text.trim()) {
    throw new EmbeddingError('embedding input must be non-empty');
  }

  let vec: number[];
  switch (PROVIDER) {
    case 'openai': vec = await embedOpenAI(text); break;
    case 'ollama': vec = await embedOllama(text); break;
    default:
      throw new EmbeddingError(
        `unknown EMBEDDING_PROVIDER='${PROVIDER}'; supported: 'openai' | 'ollama'`,
      );
  }

  if (vec.length !== EXPECTED_DIMS) {
    throw new EmbeddingError(
      `embedding provider '${PROVIDER}' returned ${vec.length} dims, ` +
      `but EMBEDDING_DIMS=${EXPECTED_DIMS} (the schema's vector column type). ` +
      `Either the wrong provider/model is configured, or the schema does not ` +
      `match — fix one or the other before captures will succeed.`,
    );
  }

  return vec;
}

export function vectorLiteral(vec: number[]): string {
  return '[' + vec.join(',') + ']';
}

// `<provider>:<model>` tag for the row's embedding_model column. Derived
// from the same env vars that drive embed(), so the tag is always in sync
// with whatever just produced the vector. See migrations/0006_embedding_model.sql
// and ADR 0001 Decision 5.
export function currentEmbeddingModelTag(): string {
  switch (PROVIDER) {
    case 'openai':
      return `openai:${Deno.env.get('OPENAI_EMBEDDING_MODEL') ?? 'text-embedding-3-small'}`;
    case 'ollama':
      return `ollama:${Deno.env.get('OLLAMA_EMBEDDING_MODEL') ?? 'nomic-embed-text'}`;
    default:
      return `${PROVIDER}:unknown`;
  }
}

// ---------------------------------------------------------------------------
// Provider: OpenAI
// ---------------------------------------------------------------------------

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

async function embedOpenAI(text: string): Promise<number[]> {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) {
    throw new EmbeddingError(
      'OPENAI_API_KEY is not set on the Edge Runtime container. ' +
      'Add it to your docker-compose.override.yml functions environment, ' +
      'or switch EMBEDDING_PROVIDER to a self-hosted backend.',
    );
  }
  const model = Deno.env.get('OPENAI_EMBEDDING_MODEL') ?? 'text-embedding-3-small';

  const res = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ model, input: text }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '<no body>');
    throw new EmbeddingError(
      `OpenAI embeddings API returned HTTP ${res.status}: ${detail}`,
      res.status,
    );
  }

  const json = await res.json() as { data?: Array<{ embedding?: number[] }> };
  const vec = json.data?.[0]?.embedding;
  if (!vec) {
    throw new EmbeddingError('OpenAI embeddings API returned no data[0].embedding');
  }
  return vec;
}

// ---------------------------------------------------------------------------
// Provider: ollama (self-hosted)
// ---------------------------------------------------------------------------

async function embedOllama(text: string): Promise<number[]> {
  const baseUrl = Deno.env.get('OLLAMA_URL');
  if (!baseUrl) {
    throw new EmbeddingError(
      'OLLAMA_URL is not set on the Edge Runtime container. ' +
      'Expected something like http://ollama:11434 (the docker-compose ' +
      'service name + default ollama port). See ' +
      'docs/deployment.md § "Phase 2 — applying the MCP edge function" ' +
      'and the ollama section in docker-compose.override.yml.example.',
    );
  }
  const model = Deno.env.get('OLLAMA_EMBEDDING_MODEL') ?? 'nomic-embed-text';

  // ollama exposes /api/embeddings; payload shape is { model, prompt }.
  // Newer ollama versions also support /api/embed with batch support;
  // we use the original endpoint for max compatibility with installed
  // versions in research-infra environments.
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '<no body>');
    throw new EmbeddingError(
      `ollama embeddings API at ${baseUrl} returned HTTP ${res.status}: ${detail}. ` +
      `Verify the model '${model}' is pulled (\`docker compose exec ollama ollama pull ${model}\`).`,
      res.status,
    );
  }

  const json = await res.json() as { embedding?: number[] };
  if (!json.embedding) {
    throw new EmbeddingError('ollama embeddings API returned no `embedding` field');
  }
  return json.embedding;
}
