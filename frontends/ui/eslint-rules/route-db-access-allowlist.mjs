/**
 * Files under `src/app` that still import `@/lib/db` for values, from before the
 * rule existed. Transport code (route handlers, server components) calls a
 * service; the query lives there (ADR-0017, `bff-service-architecture.md`).
 *
 * One list, mirrored in the `typescript/no-restricted-imports` override of
 * `.oxlintrc.json` (so an editor and `bun run lint` flag a new offender at once;
 * `lint-config.spec.mjs` fails when the mirror drifts) and read by
 * `src/lib/db/server-component-db-access.spec.ts` (which also fails when an entry
 * here no longer offends). Shrink it; never grow it.
 */
export const PRE_EXISTING_DB_IMPORTERS = [
  'app/api/conversations/[id]/route.ts',
  'app/api/internal/agent-profiler-spans/route.ts',
  'app/api/internal/citation-events/route.ts',
  'app/api/internal/memory/route.ts',
  'app/api/internal/usage/route.ts',
  'app/api/organization/memory/[itemId]/route.ts',
  'app/api/organization/memory/route.ts',
  'app/api/projects/[id]/memory/[itemId]/route.ts',
  'app/api/projects/[id]/memory/route.ts',
  'app/api/sharing/[resourceType]/[resourceId]/grants/route.ts',
  'app/api/sharing/[resourceType]/[resourceId]/route.ts',
]
