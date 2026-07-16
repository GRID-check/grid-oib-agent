/**
 * Shared encoding for the `X-Grid-Model-Overrides` header.
 *
 * Absorbed into `@/lib/request-context` (backlog T3-9: one typed
 * builder/parser pair for every `X-Grid-*` cross-cutting context header,
 * instead of each header's encoding living wherever its first caller
 * happened to need it). Re-exported here so existing importers of this
 * module — and proxy routes that only need this one header's wire encoding,
 * not the full `GridRequestContext` builder — don't have to change their
 * import path.
 */

export { encodeModelOverridesHeader } from '@/lib/request-context'
