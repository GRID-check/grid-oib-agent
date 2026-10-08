import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'

/**
 * The dark-launch gate every Archiv route applies (ADR-0024): the refusing
 * response, or `null` when `organization-archiv` is on for the caller's
 * organization. A function over the session so a shared route handler can take
 * it as its gate without knowing which flag it is.
 */
export function requireArchivFeature(session: Parameters<typeof requireFeature>[0]): Response | null {
  return requireFeature(session, FEATURE_FLAGS.orgArchiv)
}
