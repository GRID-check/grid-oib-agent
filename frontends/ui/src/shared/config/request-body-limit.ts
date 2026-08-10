/**
 * The largest request body the server will accept, and the IFC ceiling it is
 * derived from.
 *
 * ## Why this is its own module, and why it imports nothing
 *
 * `next.config.ts` reads this at server start, inside the PRODUCTION image,
 * where almost none of `src/` exists — only what `deploy/Dockerfile` copies in
 * explicitly. A transitive import that the Dockerfile does not copy is a
 * MODULE_NOT_FOUND CrashLoopBackOff that no local check catches, which is
 * exactly what `next-config-runtime-copies.spec.ts` exists to prevent and why
 * that spec's contract is that config imports stay import-free.
 *
 * So the numbers live here, with no imports at all, and everything else reads
 * them from here: `@/lib/bim/types` re-exports the IFC pair for the pipeline,
 * `@/shared/config/file-upload` builds the client's accept-list and ceilings
 * on top, and `@/lib/api/handler` names the transport limit when a body
 * arrives truncated.
 *
 * ## Why the transport ceiling is not the document limit
 *
 * `FILE_UPLOAD_MAX_SIZE_MB` (100 MB) is sized for documents. An Einreichung
 * IFC is routinely 50–500 MB and is measured against `BIM_MAX_IFC_BYTES`
 * instead. When the transport limit still followed the document figure, a
 * 149 MB model passed both validators and was then cut off in front of the
 * handler, so `request.formData()` threw
 * `TypeError: Failed to parse body as FormData` — an unhandled 500 that named
 * neither the file nor a size (issue #369). The ceiling therefore has to clear
 * the largest file ANY route may admit, not the largest document.
 */

/** Default ceiling on a `.ifc` upload, overridable with `BIM_MAX_IFC_BYTES`. */
export const DEFAULT_MAX_IFC_BYTES = 250 * 1024 * 1024

/** Default ceiling on every other upload, overridable with `FILE_UPLOAD_MAX_SIZE_MB`. */
export const DEFAULT_MAX_DOCUMENT_BYTES = 100 * 1024 * 1024

function positive(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * The configured IFC ceiling. Shared by the upload validators (what the
 * browser may send) and the extractor (what it will parse), so the two layers
 * cannot disagree about the same file.
 */
export function maxIfcBytesFrom(env: Record<string, string | undefined>): number {
  return positive(env.BIM_MAX_IFC_BYTES) ?? DEFAULT_MAX_IFC_BYTES
}

/**
 * The transport ceiling: `next.config.ts` turns this into
 * `proxyClientMaxBodySize` and the server-action body limit.
 */
export function requestBodyLimitBytes(
  env: Record<string, string | undefined> = process.env
): number {
  const documentLimit = positive(env.FILE_UPLOAD_MAX_SIZE_MB)
    ? (positive(env.FILE_UPLOAD_MAX_SIZE_MB) as number) * 1024 * 1024
    : DEFAULT_MAX_DOCUMENT_BYTES
  return Math.max(documentLimit, maxIfcBytesFrom(env))
}
