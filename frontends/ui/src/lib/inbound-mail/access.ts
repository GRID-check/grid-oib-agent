import 'server-only'
/**
 * Who may see and decide the E-Mail-Eingang, and who may manage a project's
 * address (ADR-0134, DECISION D9 and §4 C1). Every route of the feature asks
 * here first, so the rule is written once.
 *
 * - **The office's switch.** With the organization's `inbound-mail`
 *   entitlement off, the address, the E-Mail-Eingang and every operation on
 *   them are not found, exactly as for a project the caller may not see.
 * - **Seeing and deciding** needs `project:documents:write` on the project
 *   (any-of the legacy `project:edit`, as every document write asks): held
 *   mail is offered for filing, and only someone who may add documents may
 *   decide where it goes. An org admin comes in through the usual bypass. A
 *   closed project still shows its mail and lets it be dismissed (RT-X13);
 *   filing into it is refused by the folder check, which asks the write as
 *   any upload does.
 * - **Filing** additionally needs write on every target folder, asked at
 *   decision time here (`requireFolderWrite`) and again by the filing job,
 *   which uploads as the person (ADR-0088, ADR-0097).
 * - **The address** is the project manager's (`project:manage`): creating,
 *   replacing and switching it off decide who can put mail in front of the
 *   office. Reading it needs only what reading the E-Mail-Eingang needs.
 *
 * Every refusal is a 404, never a 403, so nobody learns that a project has an
 * E-Mail-Eingang they may not open.
 */

import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { can } from '@/lib/authz/decide'
import { isInboundMailEnabled } from '@/lib/authz/feature-flags'
import { DOCUMENT_WRITE_PERMISSIONS } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'

/** What a reviewer of the project's E-Mail-Eingang is allowed beyond reading it. */
export interface MailReviewAccess {
  /** The project is closed: its mail is shown and may be dismissed, never filed until it is reopened. */
  closed: boolean
}

/** The organization's `inbound-mail` entitlement, as a 404 when it is off. */
export function requireInboundMailEnabled(session: AuthorizedSession): void {
  if (!isInboundMailEnabled(session)) throw new NotFoundError()
}

/**
 * The caller may see and decide the project's held mail: the entitlement,
 * then `project:documents:write` (or `project:edit`), asked as if the project
 * were open so a closed project's mail can still be read and dismissed.
 */
export async function requireMailReviewer(session: AuthorizedSession, projectId: string): Promise<MailReviewAccess> {
  requireInboundMailEnabled(session)
  const access = await requireProjectAccess(session, projectId, DOCUMENT_WRITE_PERMISSIONS, { evenWhenClosed: true })
  return { closed: access.closed }
}

/** The caller may manage the project's address: the entitlement, then `project:manage`. */
export async function requireAddressManager(session: AuthorizedSession, projectId: string): Promise<void> {
  requireInboundMailEnabled(session)
  await requireProjectAccess(session, projectId, 'project:manage')
}

/** Whether the caller manages the project (`project:manage`), asked through the decision point, never by role name. */
export function managesProject(session: AuthorizedSession, projectId: string): Promise<boolean> {
  return can(session, 'project:manage', { type: 'project', id: projectId })
}
