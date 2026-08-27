/**
 * The URL surface of the authenticated `/app` area, checked in.
 *
 * This list exists because the app shell is assembled out of ROUTE GROUPS.
 * A group directory — `(shell)` — is how Next.js lets several sibling segments
 * share one layout without that layout appearing in the URL, and it is the only
 * mechanism that can put a persistent frame above Archiv, Postfach,
 * Organisation, Plattform, Profil and the projects without moving any of them.
 *
 * The whole point is that the URLs do NOT change. A group is invisible in the
 * URL, so a directory renamed from `(shell)` to `shell` — or a page dragged one
 * level too deep while refactoring — changes every link, bookmark and redirect
 * in the product and NOTHING in the type system notices. `app-routes.spec.ts`
 * walks `src/app/app` on disk, strips the `(…)` groups exactly as the router
 * does, and asserts the result equals this list.
 *
 * Adding a page? Add its URL here in the same commit. That is the point: the
 * list is a decision record, not a mirror of the filesystem.
 */
export const APP_ROUTE_URLS: readonly string[] = [
  '/app',
  '/app/archiv',
  '/app/chat',
  '/app/inbox',
  '/app/onboarding/organization',
  '/app/organization',
  '/app/organization/access',
  '/app/organization/budgets',
  '/app/organization/compliance',
  '/app/organization/enterprise',
  '/app/organization/models',
  '/app/organization/storage',
  '/app/platform',
  '/app/platform/cards',
  '/app/platform/knowledge',
  '/app/platform/lessons',
  '/app/platform/maintenance',
  '/app/platform/models',
  '/app/platform/norms',
  '/app/platform/quality',
  '/app/platform/retrieval',
  '/app/platform/skills',
  '/app/platform/storage',
  '/app/profile',
  '/app/projects',
  '/app/projects/[id]',
  '/app/projects/[id]/chat',
  '/app/projects/[id]/files',
  '/app/projects/[id]/history',
  '/app/projects/[id]/intake',
  '/app/projects/[id]/jobs',
  '/app/projects/[id]/knowledge',
  '/app/projects/[id]/members',
  '/app/projects/[id]/model',
  '/app/projects/[id]/research',
  '/app/projects/[id]/settings',
  '/app/projects/[id]/skills',
]
