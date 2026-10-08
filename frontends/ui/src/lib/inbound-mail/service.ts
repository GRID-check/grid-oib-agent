/**
 * The project mail inbox (ADR-0075): the project's address, as the settings
 * surface reads and rotates it.
 *
 * Receiving a mail is `./receive` (the webhook) and filing it is `./job`
 * (a job on the BFF's queue); this module is the part a signed-in person reaches.
 */

import 'server-only'
import { ConflictError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { can } from '@/lib/authz/decide'
import { isProjectMailInboxEnabled } from '@/lib/authz/feature-flags'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { InboundMailAddressRow } from '@/lib/db/schema'
import { findProjectInOrg } from '@/lib/projects/repository'
import { formatInboundAddress, inboundMailDomain, mintToken, projectSlug } from './address'
import type { InboundAddressResponse, RotateInboundAddressResponse } from './contract'
import {
  findActiveAddressForProject,
  insertAddress,
  rotateAddress,
  type NewAddress,
} from './repository'

/** Tries at minting a token that does not collide (60 bits: one is plenty). */
const MINT_ATTEMPTS = 3

/**
 * The project's address, minted on first read.
 *
 * Requires document write access (`project:documents:write` any-of
 * `project:edit`, the same pair `uploadDocument` asks for): an address is only
 * worth showing to somebody whose mail it would accept.
 */
export async function getInboundAddress(
  session: AuthorizedSession,
  projectId: string
): Promise<InboundAddressResponse> {
  await requireProjectAccess(session, projectId, ['project:documents:write', 'project:edit'])
  // The permission rotation checks, asked through the decision point rather
  // than read off a role name: a custom role holding it can rotate.
  const canRotate = await can(session, 'project:manage', { type: 'project', id: projectId })
  const domain = inboundMailDomain()
  if (!domain || !isProjectMailInboxEnabled(session)) return { enabled: false, address: null, canRotate }

  const row =
    (await findActiveAddressForProject(session.organizationId, projectId)) ??
    (await mintAddress(session, projectId, 'lazy'))
  return { enabled: true, address: formatInboundAddress(row.slug, row.token, domain), canRotate }
}

/** Revoke the project's address and mint a new one. Requires `project:manage`. */
export async function rotateInboundAddress(
  session: AuthorizedSession,
  projectId: string
): Promise<RotateInboundAddressResponse> {
  await requireProjectAccess(session, projectId, 'project:manage')
  const domain = inboundMailDomain()
  if (!domain || !isProjectMailInboxEnabled(session)) throw new NotFoundError('Inbound mail is not enabled')
  const row = await mintAddress(session, projectId, 'rotate')
  return { address: formatInboundAddress(row.slug, row.token, domain) }
}

async function mintAddress(
  session: AuthorizedSession,
  projectId: string,
  mode: 'lazy' | 'rotate'
): Promise<InboundMailAddressRow> {
  const project = await findProjectInOrg(projectId, session.organizationId)
  if (!project) throw new NotFoundError('Project not found')
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
    const input: NewAddress = {
      organizationId: session.organizationId,
      projectId,
      token: mintToken(),
      slug: projectSlug(project.name),
      createdBy: session.userId,
    }
    const result =
      mode === 'rotate' ? await rotateAddress({ ...input, revokedBy: session.userId }) : await insertAddress(input)
    if (result.ok) return result.row
    if (result.conflict === 'token') continue
    // A concurrent request gave the project its active address first.
    const winner = await findActiveAddressForProject(session.organizationId, projectId)
    if (winner && mode === 'lazy') return winner
    if (mode === 'rotate') throw new ConflictError('The address was rotated concurrently. Try again.')
  }
  throw new ConflictError('Could not mint a project mail address. Try again.')
}
