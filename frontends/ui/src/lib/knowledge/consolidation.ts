/**
 * Consolidation primitives shared by every knowledge store that de-duplicates
 * natural-language findings at write time — project/organization memory
 * (`lib/projects/memory-service.ts`) and platform lessons
 * (`lib/platform-lessons`).
 *
 * Extracted from the memory service rather than re-implemented: the polarity
 * split in particular encodes a failure mode ("a correction is token-wise
 * nearly identical to the claim it corrects") that any second copy would
 * re-learn the hard way. One engine, two stores
 * (docs/architecture/platform-failure-learning.md, "shared substrate").
 */

/**
 * Normalize content for duplicate detection: lowercase, non-alphanumerics
 * collapsed to single spaces, trimmed. ASCII-only on purpose — umlauts fold to
 * spaces. Must stay in lock-step with the SQL expression in the
 * project_memory partial unique indexes (migration 0010):
 * `btrim(regexp_replace(lower(content), '[^a-z0-9]+', ' ', 'g'))`.
 */
export function normalizeContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * The German-preserving twin: keeps ä/ö/ü/ß, because "Maß" and "Mas" are
 * different words and a German compliance product must not merge across them.
 * Lock-step partner: the `uniq_platform_lessons_content_live` index expression
 * in migration 0068 (`[^a-z0-9äöüß]+`).
 *
 * NOT adopted by project memory: its 0010 index expressions are already
 * deployed with the ASCII fold, and the JS normalizer must match the index or
 * the 23505 race backstop stops matching what the check matched. Migrating
 * memory to this normalizer means rewriting those indexes in the same change.
 */
export function normalizeContentGerman(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/g, ' ')
    .trim()
}

/**
 * Token overlap above which two same-kind findings are the same fact restated
 * (paraphrase-level dedup). Deliberately high: a false positive merges two
 * distinct findings and loses one; a false negative only costs a redundant row
 * a curator can prune.
 */
export const NEAR_DUP_JACCARD_THRESHOLD = 0.8
/** Very short findings have jumpy token sets; keep them exact-dup only. */
export const NEAR_DUP_MIN_TOKENS = 3

/**
 * Negation particles whose presence flips what a finding asserts.
 *
 * A correction is token-wise almost identical to the claim it corrects:
 * "OIB-RL 2.1 is not applicable" vs "OIB-RL 2.1 is applicable" score 0.91
 * Jaccard, well over NEAR_DUP_JACCARD_THRESHOLD. Merging those keeps the OLD
 * row and only refreshes its confidence and timestamps — so the correction is
 * discarded and the stale claim survives looking freshly confirmed. Polarity is
 * therefore checked BEFORE any merge: opposed polarity is a contradiction, and
 * a contradiction supersedes instead of merging.
 */
const NEGATION_TOKENS = new Set([
  // English
  'not',
  'no',
  'never',
  'without',
  'cannot',
  'none',
  'neither',
  'nor',
  // German
  'nicht',
  'kein',
  'keine',
  'keinen',
  'keinem',
  'keiner',
  'keines',
  'nie',
  'niemals',
  'ohne',
  'weder',
])

/**
 * Boolean literals, which flip meaning the same way a negation does — findings
 * routinely carry flag values verbatim ("betriebsanlage=false").
 */
const BOOLEAN_TOKENS = new Set(['true', 'false', 'yes', 'ja', 'nein', 'wahr', 'falsch'])

export function contentTokenList(
  content: string,
  normalize: (content: string) => string = normalizeContent
): string[] {
  return normalize(content).split(' ').filter(Boolean)
}

export function contentTokens(
  content: string,
  normalize: (content: string) => string = normalizeContent
): Set<string> {
  return new Set(contentTokenList(content, normalize))
}

/**
 * A comparable summary of what a content asserts: negation PARITY (double
 * negation reads positive again) plus the boolean literals it carries. Two
 * contents whose signatures differ assert opposite things.
 */
export function polaritySignature(
  content: string,
  normalize: (content: string) => string = normalizeContent
): string {
  let negations = 0
  const booleans: string[] = []
  for (const token of contentTokenList(content, normalize)) {
    if (NEGATION_TOKENS.has(token)) negations++
    else if (BOOLEAN_TOKENS.has(token)) booleans.push(token)
  }
  return `${negations % 2}|${[...new Set(booleans)].sort().join(',')}`
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared++
  return shared / (a.size + b.size - shared)
}
