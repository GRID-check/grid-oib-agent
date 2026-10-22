import 'server-only'
/**
 * The file types an organization accepts, for work that has no session: a
 * mail that arrived at a project's address is offered for filing part by part,
 * and only a part the upload would accept is offered (`type_not_accepted`
 * otherwise, shown to the person rather than dropped).
 *
 * The same answer `assertUploadTypeAllowed` gives a session of that
 * organization: the flags come from WorkOS per organization
 * (`enabledFlagsForOrganization`, the set a pinned session carries), they are
 * read through the session's own gates (`isFeatureEnabled`, so a deployment
 * that authenticates nobody gets the same fixed answer), and the list from the
 * shared resolver (`acceptedUploadExtensions`). `accepted-types.spec.ts` holds
 * the two to equality, row by row.
 *
 * A failed flag lookup throws rather than answering "none": the caller is a
 * job, which retries once WorkOS is back, where "none" would refuse every
 * picture for as long as it was down. The VLM capability fails closed, as for
 * the upload itself.
 */

import type { GridSession } from '@/lib/auth/types'
import { FEATURE_FLAGS, isFeatureEnabled, isIfcModelsEnabled } from '@/lib/authz/feature-flags'
import { enabledFlagsForOrganization } from '@/lib/workos/feature-flags'
import { acceptedUploadExtensions, uploadExtensionOf } from '@/shared/config/file-upload'
import { isVlmConfigured } from './vlm-capability'

/** The accepted extensions (lowercased, with the dot) for a holder of these flags, given the VLM capability. */
export function acceptedTypesForFlags(flags: Pick<GridSession, 'featureFlags'>, vlmAvailable: boolean): readonly string[] {
  return acceptedUploadExtensions({
    imageUploadEnabled: isFeatureEnabled(flags, FEATURE_FLAGS.imageUpload),
    vlmAvailable,
    ifcUploadEnabled: isIfcModelsEnabled(flags),
  })
}

/** The accepted extensions of `organizationId`, without a session. Throws when WorkOS cannot be read. */
export async function acceptedTypesForOrganization(organizationId: string): Promise<readonly string[]> {
  const [featureFlags, vlmAvailable] = await Promise.all([
    enabledFlagsForOrganization(organizationId),
    isVlmConfigured(),
  ])
  return acceptedTypesForFlags({ featureFlags }, vlmAvailable)
}

/** Whether a file of this name is of a type in `accepted`, read as the upload reads it: no extension is no type. */
export function isAcceptedType(fileName: string, accepted: readonly string[]): boolean {
  const extension = uploadExtensionOf(fileName)
  return extension !== '' && accepted.includes(extension)
}
