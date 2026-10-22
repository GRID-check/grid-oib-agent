import 'server-only'
/**
 * Telling people that mail waits in a project's E-Mail-Eingang (ADR-0134,
 * `inbound_mail.waiting`). Every held mail is announced, whoever sent it
 * (RT-X1): a mail nobody hears of would expire unseen.
 *
 * Who is told (D9, RT-S14):
 * - the sender, when the mail is `member_verified`, addressed to the project
 *   (or the member's own Bcc copy, D4) and the member may read the project:
 *   their own mail waits for them;
 * - otherwise the project's managers (`project:manage`). A `member_unverified`
 *   mail never notifies the member it names: whoever forged their address must
 *   not reach them through us.
 *
 * What the row says: one row per recipient and project, counted, naming the
 * project and never the mail. No sender, no subject, no file name reaches the
 * row or a push, so a stranger's words never land on a lock screen; mail from
 * an unconfirmed domain or sent automatically adds a line saying so
 * (`unconfirmed`), and is otherwise announced like any other (D3).
 *
 * Best effort: the mail is held before this runs, and a lost row costs a
 * notification, never the mail. The other types of the E-Mail-Eingang
 * (expiring, decided, filing failed, cap reached, appended, follow expiring)
 * are announced by the packages whose events they report.
 */

import type { InboundSenderTrust, SenderFlag } from '@/lib/inbound-mail/inbound-mail-vocabulary'
import { userHoldsProjectPermission } from '@/lib/authz/project-membership'
import { bestEffortInbox } from '@/lib/inbox/best-effort'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { emitInboxItems, type InboxEmission } from '@/lib/inbox/service'
import { findProjectInOrg } from '@/lib/projects/repository'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'

export const INBOUND_MAIL_WAITING = 'inbound_mail.waiting' as const

/** What the announcement reads of a held mail. Ids and labels only. */
export interface WaitingMail {
  organizationId: string
  projectId: string
  mailId: string
  senderTrust: InboundSenderTrust
  senderUserId: string | null
  senderFlags: readonly SenderFlag[]
  automatic: boolean
}

/**
 * Whether the mail's own sender is the one to tell (D9): a verified member's
 * mail to the project, or their own Bcc copy. Pure; whether they may read the
 * project is asked by {@link waitingRecipients}.
 */
export function notifiesSender(mail: Pick<WaitingMail, 'senderTrust' | 'senderUserId' | 'senderFlags'>): boolean {
  if (mail.senderTrust !== 'member_verified' || !mail.senderUserId) return false
  return !mail.senderFlags.includes('not_addressed_to_project') || mail.senderFlags.includes('bcc_own')
}

/** Whether the row says that mail from an unconfirmed domain, or automatic mail, is among what waits. */
export function isUnconfirmed(mail: Pick<WaitingMail, 'senderTrust' | 'automatic'>): boolean {
  return mail.automatic || mail.senderTrust === 'external_unverified' || mail.senderTrust === 'member_unverified'
}

/**
 * Who is told about this mail: its sender (see {@link notifiesSender}) when
 * they may read the project, else every member who manages it. The directory
 * is the whole roster; an unreadable one tells nobody, and says so in the log.
 */
export async function waitingRecipients(mail: WaitingMail): Promise<string[]> {
  const holds = (userId: string, permission: 'project:view' | 'project:manage') =>
    userHoldsProjectPermission({ organizationId: mail.organizationId }, mail.projectId, userId, permission).catch(() => false)
  if (notifiesSender(mail) && mail.senderUserId && (await holds(mail.senderUserId, 'project:view'))) {
    return [mail.senderUserId]
  }
  const directory = await loadOrganizationDirectory(mail.organizationId)
  if (directory.size === 0) console.warn(`[inbound-mail] nobody to tell about mail ${mail.mailId}: the directory is empty`)
  const verdicts = await Promise.all(
    [...directory.keys()].map(async (userId) => ((await holds(userId, 'project:manage')) ? userId : null)),
  )
  return verdicts.filter((userId): userId is string => userId !== null)
}

/** The rows for one held mail: one per recipient, folding into the project's row. Null when the project is gone. */
export async function waitingEmissions(mail: WaitingMail, recipients: readonly string[]): Promise<InboxEmission[] | null> {
  const project = await findProjectInOrg(mail.projectId, mail.organizationId)
  if (!project) return null
  const payload = { subject: project.name, ...(isUnconfirmed(mail) ? { variant: 'unconfirmed' } : {}) }
  return recipients.map((recipientUserId) => ({
    organizationId: mail.organizationId,
    recipientUserId,
    type: INBOUND_MAIL_WAITING,
    resourceType: 'project',
    resourceId: mail.projectId,
    anchorId: mail.mailId,
    // Nobody acted: a person's own mail still tells them it waits.
    actorUserId: null,
    groupKey: inboxGroupKey(INBOUND_MAIL_WAITING, 'project', mail.projectId),
    payload,
  }))
}

/** Announce one held mail. Never throws; whether rows were written. */
export async function announceWaiting(mail: WaitingMail): Promise<boolean> {
  let written = false
  await bestEffortInbox(`${INBOUND_MAIL_WAITING} for mail ${mail.mailId}`, mail.organizationId, async () => {
    const recipients = await waitingRecipients(mail)
    const emissions = recipients.length > 0 ? await waitingEmissions(mail, recipients) : null
    if (!emissions || emissions.length === 0) return
    written = (await emitInboxItems(emissions)) > 0
  })
  return written
}
