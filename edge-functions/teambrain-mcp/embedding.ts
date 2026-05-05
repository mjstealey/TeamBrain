// embedding.ts — OpenAI text-embedding-3-small wrapper.
//
// Decision (Phase 2 § A1): text-embedding-3-small produces 1536-dim
// vectors which match `public.thoughts.embedding vector(1536)` exactly.
// Switching models to a different dimension would require a schema
// migration (alter column type) plus a backfill — defer until OpenAI
// access becomes a constraint.
//
// OPENAI_API_KEY is supplied via the supabase-stack `.env` file; the
// dispatcher in `main/index.ts` passes the entire env through to every
// worker (`envVars` argument to `EdgeRuntime.userWorkers.create`).

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const EMBEDDING_MODEL       = 'text-embedding-3-small';
const EMBEDDING_DIMS        = 1536;

export class EmbeddingError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

export async function embed(text: string): Promise<number[]> {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) {
    throw new EmbeddingError(
      'OPENAI_API_KEY is not set on the Edge Runtime container; ' +
      'add it to ~/scratch/supabase-stack/.env and `docker compose up -d` to apply.',
    );
  }

  // OpenAI's API rejects empty input. The MCP tool layer also enforces
  // this via zod (.min(1)) — guard here too as a defense in depth.
  if (!text || !text.trim()) {
    throw new EmbeddingError('embedding input must be non-empty');
  }

  const res = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '<no body>');
    throw new EmbeddingError(
      `OpenAI embeddings API returned HTTP ${res.status}: ${detail}`,
      res.status,
    );
  }

  const json = await res.json() as {
    data?: Array<{ embedding?: number[] }>;
  };

  const vec = json.data?.[0]?.embedding;
  if (!vec || vec.length !== EMBEDDING_DIMS) {
    throw new EmbeddingError(
      `OpenAI embeddings API returned unexpected shape: ` +
      `data[0].embedding.length=${vec?.length ?? 'undefined'}, expected ${EMBEDDING_DIMS}`,
    );
  }

  return vec;
}

// pgvector accepts a JSON-array-of-floats string when inserting via
// PostgREST: `'[0.1, 0.2, ...]'::vector`. supabase-js will auto-cast
// when the column type is vector, so we serialize once on the client
// rather than letting JS implicit serialization pick a representation.
export function vectorLiteral(vec: number[]): string {
  return '[' + vec.join(',') + ']';
}
