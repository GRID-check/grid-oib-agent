/**
 * How the waiting list is arranged (DECISION §9, „List row“):
 *
 * - mails that continue the same E-Mail-Verlauf and would be pre-selected
 *   into it are grouped, so the conversation is filed in one press
 *   („3 E-Mails in E-Mail-Verlauf „…“ ablegen (wird Fassung 10)“);
 * - mail whose domain is not confirmed, and automatic mail, sit in one
 *   collapsed group at the end. They are listed, never hidden (every held
 *   mail is announced, D3), but they do not crowd out the conversation;
 * - everything else keeps the server's order (newest first).
 *
 * A mail that is not pre-selectable never joins a thread group: the group's
 * one button carries no acknowledgement (RT-S5).
 *
 * Pure.
 */

import type { InboundMailSummaryView } from '@/lib/inbound-mail/inbound-mail-wire'

export type ListSection =
  | { kind: 'mail'; mail: InboundMailSummaryView }
  | {
      kind: 'thread'
      threadId: string
      name: string
      /** The Fassung the thread reaches once every mail of the group is filed. */
      finalVersion: number
      mails: InboundMailSummaryView[]
    }
  | { kind: 'quiet'; mails: InboundMailSummaryView[] }

/** Mail the list keeps quiet: an unconfirmed stranger, or a machine. */
export function isQuietMail(mail: Pick<InboundMailSummaryView, 'senderTrust' | 'automatic'>): boolean {
  return mail.automatic || mail.senderTrust === 'external_unverified'
}

export function listSections(mails: readonly InboundMailSummaryView[], options: { grouped: boolean }): ListSection[] {
  if (!options.grouped) return mails.map((mail) => ({ kind: 'mail', mail }))
  const quiet = mails.filter(isQuietMail)
  const loud = mails.filter((mail) => !isQuietMail(mail))

  const byThread = new Map<string, InboundMailSummaryView[]>()
  for (const mail of loud) {
    if (mail.status !== 'waiting' || !mail.thread?.preselected) continue
    const group = byThread.get(mail.thread.threadId) ?? []
    group.push(mail)
    byThread.set(mail.thread.threadId, group)
  }

  const sections: ListSection[] = []
  const placed = new Set<string>()
  for (const mail of loud) {
    const threadId = mail.thread?.threadId
    const group = threadId ? byThread.get(threadId) : undefined
    // Only a member of the group goes with it: a mail of the same thread that is not pre-selectable stands alone.
    if (group && group.length > 1 && group.includes(mail) && mail.thread) {
      if (placed.has(mail.thread.threadId)) continue
      placed.add(mail.thread.threadId)
      const base = Math.min(...group.map((member) => member.thread?.nextVersion ?? 1))
      sections.push({ kind: 'thread', threadId: mail.thread.threadId, name: mail.thread.name, finalVersion: base + group.length - 1, mails: group })
    } else {
      sections.push({ kind: 'mail', mail })
    }
  }
  if (quiet.length > 0) sections.push({ kind: 'quiet', mails: quiet })
  return sections
}

/** The mails in reading order, as J and K walk them; a collapsed quiet group is skipped. */
export function visibleMails(sections: readonly ListSection[], quietOpen: boolean): InboundMailSummaryView[] {
  return sections.flatMap((section) => {
    if (section.kind === 'mail') return [section.mail]
    if (section.kind === 'thread') return section.mails
    return quietOpen ? section.mails : []
  })
}
