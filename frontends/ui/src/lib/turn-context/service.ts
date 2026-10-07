import 'server-only'
import { drewOnOtherProjects } from '@/lib/conversations/cross-project-use'
import { loadReferenceBrief } from '@/lib/cross-project/reference-brief'
import type { AuthorizedSession } from '@/lib/auth/types'
import { NotFoundError } from '@/lib/api/errors'
import { withPlatformAccess } from '@/lib/db/tenant-context'
import { requireProjectAccess } from '@/lib/authz/projects'
import { CHAT_PERMISSIONS } from '@/lib/authz/chat'
import { findConversationTenancy } from '@/lib/conversations/repository'
import { requireResourceAccess } from '@/lib/sharing/access'
import { loadProjectPromptView } from '@/lib/project-profile/prompt-view'
import { resolveOrgInstructions } from '@/lib/org-instructions/service'
import { buildProjectMemoryDigest } from '@/lib/projects/memory-service'
import { buildProposalDecisionsBlock, composeMemoryContext } from '@/lib/projects/proposal-decisions'
import { buildReviewDecisionsBlock } from '@/lib/documents/review-decisions'
import type { VerifiedGridRequestContext } from '@/lib/request-context'
import type { TurnContextRequest, TurnContextResponse } from './wire'

async function advisory<T>(what: string, load: () => Promise<T>): Promise<T | null> {
  try {
    return await load()
  } catch (error) {
    console.warn(`[Turn Context API] Failed to ${what}:`, error)
    return null
  }
}

/** Reload prompt data only after today's requester access has been checked. */
export async function loadTurnContext(
  session: AuthorizedSession,
  context: VerifiedGridRequestContext,
  input: TurnContextRequest,
): Promise<TurnContextResponse> {
  const { organizationId, projectId, conversationId } = context
  if (projectId) await requireProjectAccess(session, projectId, CHAT_PERMISSIONS)
  if (conversationId) {
    // An RLS-hidden foreign row is not a genuinely new conversation.
    const tenancy = await withPlatformAccess(
      'turn-context conversation existence probe; all access is checked before prompt reads',
      () => findConversationTenancy(conversationId),
    )
    // A first turn names a client-generated id before its row exists.
    if (tenancy) {
      if (tenancy.organizationId !== organizationId || tenancy.deletedAt) throw new NotFoundError()
      await requireResourceAccess(session, 'conversation', conversationId, 'viewer')
    }
  }

  const [projectContext, orgInstructions, digest, decisions, reviewDecisions, drewOnOthers, referenceProjects] = await Promise.all([
    projectId ? loadProjectPromptView(projectId, organizationId) : Promise.resolve(null),
    resolveOrgInstructions(organizationId),
    buildProjectMemoryDigest(projectId ?? undefined, organizationId, { query: input.query || undefined }),
    projectId
      ? advisory('load proposal decisions', () => buildProposalDecisionsBlock(projectId, organizationId))
      : Promise.resolve(null),
    conversationId
      ? advisory('load review decisions', () => buildReviewDecisionsBlock(conversationId, organizationId))
      : Promise.resolve(null),
    // Not advisory: a turn that wrongly believed its doors open would only be
    // refused at the BFF, but the read is one indexed probe and a failure here
    // is a failure to load the turn's context like any other.
    conversationId ? drewOnOtherProjects(conversationId, organizationId) : Promise.resolve(false),
    // The office's closed projects, most like this one first: what the agent may look into on its own.
    advisory('load reference projects', () => loadReferenceBrief(organizationId, projectId ?? null)),
  ])
  return {
    projectContext,
    projectMemory: composeMemoryContext(digest, decisions, reviewDecisions),
    orgInstructions,
    drewOnOtherProjects: drewOnOthers,
    referenceProjects,
  }
}
