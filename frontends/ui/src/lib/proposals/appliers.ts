/**
 * Applying a memory note or a profile change, on the server, as the deciding
 * person (ADR-0105). The file operations have their own module
 * (`./executors`); these two are one write each.
 *
 * | Kind | Service (the door a person's own click uses) |
 * |---|---|
 * | `memory`, project scope | `addProjectMemoryItem` (`POST /api/projects/[id]/memory`) |
 * | `memory`, organization scope | `createOrganizationMemoryItem` (`POST /api/organization/memory`) |
 * | `project_profile` | `patchProjectProfile` (`POST /api/projects/[id]/profile/patches`) |
 *
 * Each returns ONE result. An outcome that belongs to the proposal (the
 * profile moved under it, a value outside the intake vocabulary) is a failed
 * result with its reason. A refusal that belongs to the decider or to the
 * moment (no right to write, a closed project, a conversation that may not
 * leave its folders now) is thrown: the service gives the claim back and the
 * proposal stays `proposed` for someone, or some time, it does not refuse.
 */

import 'server-only'
import type { Locale } from '@/i18n/config'
import { BadRequestError, ConflictError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireMayRememberFrom } from '@/lib/conversations/cross-project-use'
import { requireMayLeaveConversation } from '@/lib/conversations/restricted-egress'
import { requireResourceAccess } from '@/lib/sharing/access'
import { patchProjectProfile } from '@/lib/project-profile/profile-service'
import { addProjectMemoryItem, createOrganizationMemoryItem } from '@/lib/projects/service'
import type { MemoryPayload, ProjectProfilePayload, ProposedChangeResult } from './types'

export interface ApplyContext {
  session: AuthorizedSession
  projectId: string
  /** The deciding person's request, for the services' audit trail. */
  request: Request
  /** Where the proposal was made; the restricted-use checks run against it. */
  originConversationId: string | null
  /** The deciding person's language, for a refusal they read. */
  locale: Locale
  /** The decider's choice to file an organization note in the project instead. */
  memoryScope?: 'project'
  /** The proposal being applied, so a route that records how a person decided can say it was a card. */
  proposalId?: string
}

/** How many words of a note name it in a result or an inbox row. */
const NOTE_LABEL_WORDS = 12

/** The note's first words, for the card's outcome line and the inbox row. */
export function noteLabel(content: string): string {
  const words = content.trim().split(/\s+/)
  return words.length > NOTE_LABEL_WORDS ? `${words.slice(0, NOTE_LABEL_WORDS).join(' ')} …` : words.join(' ')
}

/**
 * Remember the note where the proposal (or the decider) says. Before anything
 * is written, the agent's own memory door's check: a conversation that drew on
 * another project still restricting its readers may not be remembered from
 * (`requireMayRememberFrom`), and a click is not a way around that. An
 * accepted correction retires the note it quotes (`supersedesContent`).
 */
export async function applyMemory(payload: MemoryPayload, context: ApplyContext): Promise<ProposedChangeResult[]> {
  const { session, projectId, originConversationId } = context
  await requireMayRememberFrom(originConversationId, session.organizationId)
  if (originConversationId) {
    // Memory is read by the whole project (or office), so a note proposed in a
    // conversation that drew on a restricted folder of THIS project is refused
    // too, as the project profile's door refuses it (ADR-0087). The thread is
    // authorized first, so the refusal says nothing about a conversation the
    // decider cannot read.
    await requireResourceAccess(session, 'conversation', originConversationId, 'viewer')
    await requireMayLeaveConversation({ conversationId: originConversationId, locale: context.locale }, session.organizationId, 'memory')
  }
  const input = {
    kind: payload.kind,
    content: payload.content,
    confidence: payload.confidence,
    sourceConversationId: originConversationId,
  }
  const options = { supersedesContent: payload.supersedes ?? null }
  const scope = context.memoryScope ?? payload.scope
  const item =
    scope === 'project'
      ? await addProjectMemoryItem(session, projectId, input, options)
      : await createOrganizationMemoryItem(session, input, options)
  return [{ label: noteLabel(payload.content), ok: true, itemId: item.id, scope }]
}

/**
 * Patch the profile with the proposal's operations, with its conversation as
 * the origin (so a confined thread is refused, ADR-0087). Applied, or already
 * applied by a colleague's concurrent accept, is `ok`; a version conflict or a
 * value outside the vocabulary fails the item with the service's reason.
 */
export async function applyProjectProfile(
  payload: ProjectProfilePayload,
  context: ApplyContext
): Promise<ProposedChangeResult[]> {
  const { session, projectId, originConversationId, locale } = context
  const origin = originConversationId ? { conversationId: originConversationId, locale } : undefined
  const label = payload.title
  try {
    await patchProjectProfile(session, projectId, payload.patch, origin)
    return [{ label, ok: true }]
  } catch (error) {
    if (error instanceof ConflictError || error instanceof BadRequestError) {
      return [{ label, ok: false, reason: error.message }]
    }
    throw error
  }
}
