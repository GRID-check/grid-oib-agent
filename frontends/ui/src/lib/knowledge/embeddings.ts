/**
 * Note embeddings — the semantic half of consolidation, for every store that
 * keeps short free-text notes (project/organization memory, platform lessons).
 *
 * **Why this exists.** Both note stores deduplicate lexically: memory by token
 * Jaccard over a 200-row scan, lessons by an LLM over a rank-ordered window.
 * Lexical similarity cannot see a paraphrase — "der Bauherr wünscht ein
 * Flachdach" and "Flachdach ist gewünscht" share no tokens — and collapsing
 * paraphrases is the entire job of a consolidation gate. The memory design
 * called the embedding gate "the single most important component; skip it and
 * memory rots" (memory-system-audit-2026-07, F2) and it was skipped.
 *
 * Consolidation is also, across the shipping agent-memory systems surveyed in
 * docs/architecture/semantic-notes.md (Copilot Memory, Cursor Memories, Devin
 * Knowledge, Windsurf Cascade), the one part nobody has solved: none publish a
 * dedup mechanism, and the documented consequence is bloat, contradiction and
 * silent override — Cursor's own guidance is a monthly manual audit. So this
 * is deliberately where the extra machinery is spent.
 *
 * **The vector lives in the note's own row** (`embedding real[]`, migration
 * 0069), not in a vector store: a second store buys ANN we do not need at
 * hundreds of rows per scope and costs a sync job, a drift mode and a deletion
 * problem — which is why F2 was never built in the first place.
 *
 * **Fail-open, always.** Every function returns null/empty rather than
 * throwing: an unavailable embedder degrades both stores to their lexical
 * path, which is worse but correct. Nothing in a write path may block on it.
 */

import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { getBackendUrl } from '@/lib/backend-proxy'

/** Bounded like the backend route; a batch is a prompt-sized thing. */
export const MAX_EMBED_BATCH = 64
/**
 * Default timeout, sized for WRITE paths (a note insert, a backfill batch)
 * where waiting beats losing the vector. Anything on a turn's critical path
 * must pass its own budget — the memory digest gives the query embed ~1s,
 * because a digest that arrives after the agent stopped waiting helps nobody.
 */
const EMBED_TIMEOUT_MS = 20_000

export interface EmbedOptions {
  /** Per-call ceiling; the caller on a hot path knows its own budget. */
  timeoutMs?: number
}

export interface EmbeddedNote {
  vector: number[]
  /** Model fingerprint to store beside the vector — see the module header. */
  fingerprint: string
}

interface BackendEmbedResponse {
  vectors?: number[][]
  fingerprint?: string
  dimensions?: number
  error?: string | null
}

/**
 * Embed up to `MAX_EMBED_BATCH` short texts. Returns null when embedding is
 * unavailable for any reason — callers then keep their lexical path.
 *
 * Result order matches input order, and a short or misaligned reply fails the
 * whole call: a vector silently attached to the wrong note is worse than no
 * vector at all.
 */
export async function embedNotes(
  texts: string[],
  options: EmbedOptions = {}
): Promise<EmbeddedNote[] | null> {
  const batch = texts.slice(0, MAX_EMBED_BATCH)
  if (batch.length === 0) return []

  let response: Response
  try {
    response = await fetch(`${getBackendUrl()}/v1/note-embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-grid-internal-token': process.env.GRID_INTERNAL_API_TOKEN ?? '',
      },
      body: JSON.stringify({ texts: batch }),
      signal: AbortSignal.timeout(options.timeoutMs ?? EMBED_TIMEOUT_MS),
    })
  } catch (error) {
    console.warn('[embeddings] Backend unreachable; staying on the lexical path:', error)
    return null
  }

  if (!response.ok) {
    console.warn('[embeddings] Backend returned', response.status)
    return null
  }

  let payload: BackendEmbedResponse
  try {
    payload = (await response.json()) as BackendEmbedResponse
  } catch {
    return null
  }
  if (payload.error) {
    console.warn('[embeddings] Embedder unavailable:', payload.error)
    return null
  }

  const vectors = payload.vectors
  const fingerprint = payload.fingerprint
  if (!Array.isArray(vectors) || !fingerprint || vectors.length !== batch.length) return null
  if (!vectors.every((vector) => Array.isArray(vector) && vector.length > 0)) return null

  return vectors.map((vector) => ({ vector, fingerprint }))
}

/** Embed exactly one text, or null. */
export async function embedNote(
  text: string,
  options: EmbedOptions = {}
): Promise<EmbeddedNote | null> {
  const embedded = await embedNotes([text], options)
  return embedded?.[0] ?? null
}

/**
 * Build the text that actually gets embedded: the note plus its structured
 * labels.
 *
 * Embedding the ENRICHED note rather than the raw content is A-MEM's one
 * cheap, transferable result — a short note carries little signal on its own,
 * and its kind/category words pull it toward the right neighbourhood. Costs a
 * string concat.
 */
export function enrichForEmbedding(content: string, labels: readonly string[]): string {
  const tags = labels.filter(Boolean).join(', ')
  return tags ? `[${tags}] ${content}` : content
}

/**
 * A SQL fragment scoring `column` against `vector` by cosine similarity, using
 * the `grid_cosine_similarity` function migration 0069 installs.
 *
 * Rows whose vector is absent, or was produced by a different model, score
 * NULL — the function returns NULL on a dimensionality mismatch, and callers
 * additionally pin `embedding_model` so a same-dimension model swap cannot
 * silently compare across models.
 */
export function cosineSimilaritySql(column: SQL | unknown, vector: number[]): SQL<number | null> {
  return sql<number | null>`grid_cosine_similarity(${column}, ${toVectorLiteral(vector)}::real[])`
}

/**
 * Render a vector as a Postgres `real[]` literal.
 *
 * Built as a string rather than passed as a JS array because the driver
 * encodes `number[]` as `numeric[]`, which does not implicitly cast to
 * `real[]` at the function call. Every element goes through `Number` and a
 * finiteness check, so nothing but digits reaches the literal.
 */
export function toVectorLiteral(vector: number[]): string {
  const parts = vector.map((value) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) {
      throw new Error('Refusing to build a vector literal from a non-finite value')
    }
    return numeric
  })
  return `{${parts.join(',')}}`
}

/** Cosine similarity in JS, for candidate sets already in memory. */
export function cosineSimilarity(a: number[], b: number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index]
    normA += a[index] * a[index]
    normB += b[index] * b[index]
  }
  if (normA === 0 || normB === 0) return null
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
