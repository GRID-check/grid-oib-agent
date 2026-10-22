import 'server-only'
/**
 * A project's mail address, as a person reads and manages it (ADR-0135,
 * DECISION §7): `inbound-mail-address-{get,create,delete,rotate}`.
 *
 * **Reading never mints.** The PR this ports minted an address on the first
 * read, so a read wrote, an agent listing projects would give each one an
 * address, and an address existed nobody had decided to publish. Here a
 * project has an address only after its manager created one; the read says
 * `none` until then.
 *
 * Creating is idempotent (the active address, if there is one), replacing
 * revokes the old address at once and ends every follow on the project
 * (D31: whoever learned the old address could otherwise keep writing into a
 * followed thread), switching off revokes it and ends the follows too. The
 * rows are history: DELETE is not the app's (migration 0186), a token is never
 * minted twice, and a revoked address answers like one never minted.
 */

import { captureServer } from '@/lib/analytics/posthog-server'
import { ConflictError, NotFoundError } from '@/lib/api/errors'
import { recordAuditEventAfterCommit } from '@/lib/audit/after-commit'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { InboundMailAddressRow } from '@/lib/db/schema'
import { publishProjectChanged } from '@/lib/realtime/door-events'
import { findProjectInOrg } from '@/lib/projects/repository'
import { managesProject, requireAddressManager, requireMailReviewer } from './access'
import { formatInboundAddress, inboundMailDomain, mintToken, projectSlug } from './address'
import { auditFollowsEnded } from './audit'
import { refusal } from './decision'
import type { InboundMailAddressView } from './inbound-mail-wire'
import {
  addressActivity,
  findActiveAddress,
  insertAddress,
  ownDomainVerifiedShare,
  replaceAddress,
  switchOffAddress,
  type AddressChange,
  type NewAddress,
} from './repository'

/** Mints tried before giving up: 60 bits make one collision unlikely, three vanishingly so. */
const MINT_ATTEMPTS = 3

/** The deployment's inbound domain, or the refusal a write gets when it receives no mail. */
function requireDomain(): string {
  const domain = inboundMailDomain()
  if (!domain) throw refusal('mail_not_received_here', 'This deployment receives no mail, so a project cannot have an address')
  return domain
}

/** The project's address as `inbound-mail-address-get` answers it. */
async function addressView(session: AuthorizedSession, projectId: string): Promise<InboundMailAddressView> {
  const domain = inboundMailDomain()
  const [active, activity, share, canManage] = await Promise.all([
    findActiveAddress(projectId),
    addressActivity(projectId),
    ownDomainVerifiedShare(session.organizationId),
    managesProject(session, projectId),
  ])
  return {
    state: !domain ? 'unavailable' : active ? 'active' : 'none',
    address: domain && active ? formatInboundAddress(active.slug, active.token, domain) : null,
    canManage,
    lastReceivedAt: activity.lastReceivedAt?.toISOString() ?? null,
    droppedLast30Days: activity.droppedLast30Days,
    ownDomainVerifiedShare: share,
  }
}

/** The project's address (`inbound-mail-address-get`). Whoever reviews the project's mail may read it; it never mints one. */
export async function getInboundMailAddress(session: AuthorizedSession, projectId: string): Promise<InboundMailAddressView> {
  await requireMailReviewer(session, projectId)
  return addressView(session, projectId)
}

/** A new address's row, as `session` mints it for the project. */
async function newAddress(session: AuthorizedSession, projectId: string): Promise<NewAddress> {
  const project = await findProjectInOrg(projectId, session.organizationId)
  if (!project) throw new NotFoundError()
  return {
    organizationId: session.organizationId,
    projectId,
    token: mintToken(),
    slug: projectSlug(project.name),
    createdBy: session.userId,
  }
}

function auditAddress(
  session: AuthorizedSession,
  action: 'inbound_mail_address.created' | 'inbound_mail_address.rotated' | 'inbound_mail_address.deleted',
  addressId: string,
  projectId: string,
  extra: { previousAddressId?: string; followsEnded?: number } = {},
): void {
  recordAuditEventAfterCommit({
    action,
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email || null },
    targetType: 'inbound_mail_address',
    targetId: addressId,
    alsoTargets: [{ type: 'project', id: projectId }],
    metadata: { projectId, ...extra },
  })
}

/**
 * Give the project an address (`inbound-mail-address-create`, `project:manage`).
 * Idempotent: a project that has one answers it unchanged, and two creates
 * racing both answer the one that won.
 */
export async function createInboundMailAddress(session: AuthorizedSession, projectId: string): Promise<InboundMailAddressView> {
  await requireAddressManager(session, projectId)
  requireDomain()
  if (await findActiveAddress(projectId)) return addressView(session, projectId)
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
    const written = await insertAddress(await newAddress(session, projectId))
    if (written.ok) {
      auditAddress(session, 'inbound_mail_address.created', written.value.id, projectId)
      publishProjectChanged(session.organizationId, projectId)
      return addressView(session, projectId)
    }
    if (written.conflict === 'active') return addressView(session, projectId)
  }
  throw new ConflictError('Could not mint a project mail address. Try again.')
}

/** After an address changed: the follows it ended, in the trail, and the live hint. */
function afterAddressChange(session: AuthorizedSession, projectId: string, change: AddressChange): void {
  auditFollowsEnded(session.organizationId, projectId, session.userId, change.followsEnded)
  publishProjectChanged(session.organizationId, projectId)
}

/**
 * Replace the project's address with a new one (`inbound-mail-address-rotate`,
 * `project:manage`): the old one stops resolving at once, and every follow on
 * the project ends. A project without an address gets its first.
 */
export async function rotateInboundMailAddress(session: AuthorizedSession, projectId: string): Promise<InboundMailAddressView> {
  await requireAddressManager(session, projectId)
  requireDomain()
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
    const written = await replaceAddress(await newAddress(session, projectId))
    if (!written.ok) {
      if (written.conflict === 'token') continue
      throw new ConflictError('The address was replaced at the same time. Read it again.')
    }
    const { row, ...change }: { row: InboundMailAddressRow } & AddressChange = written.value
    auditAddress(session, 'inbound_mail_address.rotated', row.id, projectId, {
      ...(change.previousAddressId ? { previousAddressId: change.previousAddressId } : {}),
      followsEnded: change.followsEnded.length,
    })
    captureServer({ event: 'inbound_mail_address_rotated', distinctId: session.userId, organizationId: session.organizationId, properties: {} })
    afterAddressChange(session, projectId, change)
    return addressView(session, projectId)
  }
  throw new ConflictError('Could not mint a project mail address. Try again.')
}

/**
 * Switch the project's address off (`inbound-mail-address-delete`,
 * `project:manage`): mail to it bounces from now on, and the project's follows
 * end. Mail already held stays held. Idempotent: no address, nothing to do.
 */
export async function deleteInboundMailAddress(session: AuthorizedSession, projectId: string): Promise<InboundMailAddressView> {
  await requireAddressManager(session, projectId)
  const change = await switchOffAddress(projectId, session.userId)
  if (change?.previousAddressId) {
    auditAddress(session, 'inbound_mail_address.deleted', change.previousAddressId, projectId)
    afterAddressChange(session, projectId, change)
  }
  return addressView(session, projectId)
}
