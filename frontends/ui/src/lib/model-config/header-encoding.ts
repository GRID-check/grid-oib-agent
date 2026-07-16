/**
 * Shared encoding for the `X-Grid-Model-Overrides` header.
 *
 * The header carries the org's active `{agentGroup: modelId}` map (see
 * `getActiveModelOverrides` in `./service`) as base64url-encoded JSON — the
 * same scheme `server.js` uses for the WebSocket upgrade path (and that
 * `buildCollectionScopeHeader` in `@/lib/collection-scope` uses for the
 * collection-scope header). Kept here, separate from `service.ts`, so proxy
 * routes that only need the wire encoding don't have to pull in the
 * DB-backed service module.
 */

export function encodeModelOverridesHeader(overrides: Record<string, string>): string {
  return Buffer.from(JSON.stringify(overrides), 'utf8').toString('base64url')
}
