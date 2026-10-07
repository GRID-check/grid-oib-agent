/**
 * Which other projects a lookup may search from this conversation: what
 * EVERYONE who reads the conversation may open, not just the asker
 * (docs/design/cross-project-escalation.md). Whatever the lookup returns then
 * sits in a transcript every reader may read, so no share is needed to make it
 * safe, and the record (`cross-project-use.ts`) only has to keep the next reader
 * out.
 *
 * | Conversation | Reach |
 * |---|---|
 * | the asker's alone (or not created yet) | every project the asker may chat in |
 * | private, shared with named people | closed projects, and the active ones every one of them may open |
 * | visible to the project or the office | closed projects: their readers cannot be enumerated |
 *
 * A closed project is open to every office member (ADR-0082), so it is in reach
 * of every conversation. Restricted folders follow the same rule one level
 * down: only a solo chat searches them ({@link AudienceReach.restrictedFolders}),
 * because whether each of several readers may read a folder of another project
 * is a question the lookup would have to ask per hit.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { userHoldsProjectPermission } from '@/lib/authz/project-membership'
import { audienceKey, isSoloAudience } from '@/lib/conversations/cross-project-use'
import { readConversationAudience } from '@/lib/conversations/restricted-use-repository'
import { getDb } from '@/lib/db'
import type { Project } from '@/lib/db/schema'
import { isProjectClosed } from '@/lib/projects/project-status'
import { listChatProjects } from '@/lib/projects/service'

/**
 * How many other readers a shared conversation's reach asks about. Beyond it
 * the reach is the closed projects alone: the bound is on WorkOS checks
 * (readers × active projects), and a conversation shared that widely is close
 * to one the project reads.
 */
export const REACH_MAX_OTHER_READERS = 10

/** How many permission checks run at the same time. */
const REACH_CHECK_CONCURRENCY = 20

export interface AudienceReach {
  /** The projects in reach, newest first, the conversation's own included when it is one. */
  projects: Project[]
  /** Whether a restricted folder the asker may read may be searched: only in a chat that is the asker's alone. */
  restrictedFolders: boolean
  /** The {@link audienceKey} this reach was computed for; the hand-out record checks it under the lock. */
  key: string
}

/** The other people who read a private conversation: its creator and grantees, the asker left out. */
function otherReaders(createdBy: string | null, grantees: readonly string[], askerId: string): string[] {
  return [...new Set([createdBy, ...grantees])].filter((person): person is string => !!person && person !== askerId)
}

/** Whether every one of `people` may open `projectId` now, asked a bounded number at a time. */
async function everyoneOpens(organizationId: string, people: readonly string[], projectId: string): Promise<boolean> {
  for (let start = 0; start < people.length; start += REACH_CHECK_CONCURRENCY) {
    const chunk = people.slice(start, start + REACH_CHECK_CONCURRENCY)
    const verdicts = await Promise.all(
      chunk.map((person) => userHoldsProjectPermission({ organizationId }, projectId, person, 'project:view'))
    )
    if (verdicts.includes(false)) return false
  }
  return true
}

/** The projects a lookup from this conversation may search, as its whole audience. See the module docstring. */
export async function audienceReach(session: AuthorizedSession, conversationId: string): Promise<AudienceReach> {
  const [audience, chat] = await Promise.all([
    readConversationAudience(getDb(), session.organizationId, conversationId),
    listChatProjects(session, 'newest'),
  ])
  const key = audienceKey(audience)
  if (isSoloAudience(audience, session.userId)) return { projects: chat, restrictedFolders: true, key }
  const closed = chat.filter((project) => isProjectClosed(project))
  const others = otherReaders(audience.createdBy, audience.grantees, session.userId)
  if (audience.visibility !== 'private' || others.length > REACH_MAX_OTHER_READERS) {
    return { projects: closed, restrictedFolders: false, key }
  }
  const kept: Project[] = []
  for (const project of chat) {
    // The conversation's own project is never searched by a lookup: no check for it.
    if (project.id === audience.projectId) continue
    if (isProjectClosed(project) || (await everyoneOpens(session.organizationId, others, project.id))) kept.push(project)
  }
  return { projects: kept, restrictedFolders: false, key }
}
