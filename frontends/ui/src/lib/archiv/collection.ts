import 'server-only'

/**
 * Deterministic RAG collection name for an organization's Archiv.
 *
 * Every project in the org retrieves against this collection in addition to its
 * own (see `lib/collection-scope.ts`), so the name MUST be a pure function of the
 * org id — no per-project or per-document component. WorkOS org ids look like
 * `org_<base32>` (already collection-safe); we defensively sanitize to the same
 * `[A-Za-z0-9_-]` charset the backend accepts for `proj_<uuid>` collections.
 */
export function archivCollectionName(organizationId: string): string {
  const safe = organizationId.replace(/[^A-Za-z0-9_-]/g, '_')
  return `archiv_${safe}`
}
