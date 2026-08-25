import { type ReactNode } from 'react'
import { getGridSession } from '@/lib/auth/session'
import { runWithTenantSlot } from '@/lib/db/tenant-context'
import { FEATURE_FLAGS, isCollaborationEnabled, isFeatureEnabled } from '@/lib/authz/feature-flags'
import { CHAT_PERMISSIONS } from '@/lib/authz/chat'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { AuthorizedSession } from '@/lib/auth/types'
import { findProjectInOrg } from '@/lib/projects/repository'
import { ProjectChatClient } from './project-chat-client'

interface ProjectChatPageProps {
  params: Promise<{ id: string }>
}

/**
 * Project chat route (server shell).
 *
 * Deliberately thin: the interactive chat surface is a client component
 * (ProjectChatClient). This server boundary exists only to resolve the two
 * chat-surface WorkOS feature flags with the session — the same
 * server-computes-`isFeatureEnabled`-then-prop-drills pattern the /app layout
 * uses for `keyboard-shortcuts` — and hand the booleans to the client tree:
 *   - `source-origin-badges`    → ReportTab origin badges
 *   - `chat-confidence-chip`     → AgentResponse confidence chip
 *   - `research-in-chat-history` → SessionsPanel Deep Research section (FB-10)
 *   - `answer-feedback`          → AgentResponse per-answer thumbs row (WS-7)
 * All fail open (visible) when enforcement is off. The project layout already
 * guards auth/access, so reaching here implies an authorized session; session
 * lookup is still wrapped defensively so a transient failure never blanks chat.
 */
const ProjectChatPage = async ({ params }: ProjectChatPageProps): Promise<ReactNode> => {
  return runWithTenantSlot(async () => {
    const { id } = await params

    let showSourceBadges = true
    let showConfidenceChip = true
    let showResearchInHistory = true
    let showAnswerFeedback = true
    // Collaboration is the one gate here that is default-DENY rather than
    // fail-open: it changes who can see a conversation, so a session-lookup
    // failure must leave it off (spec NF-7).
    let canCollaborate = false
    let organizationId: string | null = null
    // Whether this reader may actually USE the agent here (`project:chat`).
    //
    // The layout admits anyone with `project:view`, which is right — a Viewer
    // reads the project's threads. But the send path enforces `project:chat`, so
    // without this a Viewer would type a question and watch it fail. Resolved
    // here because the authz modules are `server-only`, and prop-drilled the way
    // `canCollaborate` already is.
    //
    // Defaults to TRUE, and FAILS CLOSED from there — which is the opposite of
    // what this comment used to claim, so state it plainly:
    // `requireProjectAccess` collapses a transport failure into the same
    // `NotFoundError` it uses for a denial (`checkResourcePermission` catches
    // the SDK error and returns false; `projects.spec.ts` pins that as "fails
    // CLOSED when the FGA call itself errors"). A `catch` here therefore cannot
    // tell "you may not chat" from "WorkOS is down", so during an outage an
    // Editor sees a locked composer.
    //
    // Kept fail-closed on purpose — the safe direction for an authorization
    // affordance — but the copy it drives must not assert a cause it cannot
    // know, which is why the notice says what to do rather than accusing the
    // reader of lacking a role. Distinguishing the two needs a signal out of
    // `requireProjectAccess` that does not exist yet; until then the honest
    // thing is to say so here.
    let canChatInProject = true
    try {
      const session = await getGridSession()
      if (session) {
        organizationId = session.organizationId
        showSourceBadges = isFeatureEnabled(session, FEATURE_FLAGS.sourceOriginBadges)
        showConfidenceChip = isFeatureEnabled(session, FEATURE_FLAGS.chatConfidenceChip)
        showResearchInHistory = isFeatureEnabled(session, FEATURE_FLAGS.researchInChatHistory)
        showAnswerFeedback = isFeatureEnabled(session, FEATURE_FLAGS.answerFeedback)
        canCollaborate = isCollaborationEnabled(session)
        if (session.organizationId && session.organizationMembershipId) {
          try {
            await requireProjectAccess(session as AuthorizedSession, id, CHAT_PERMISSIONS)
          } catch {
            canChatInProject = false
          }
        }
      }
    } catch {
      // Fail open: a session-lookup problem must not hide chat affordances.
    }

    // Project lookup serves two consumers: the Deep Research section scopes its
    // job fetch to this project's Qdrant collection (FB-10), and the chat
    // surface shows the project name in the thread-header breadcrumb and the
    // composer scope chip (WS-3). Fail-soft: a missing row just degrades to an
    // unscoped section / nameless scope chip, never a broken chat.
    let projectCollection: string | null = null
    let projectName: string | null = null
    try {
      // Scoped to the session's organization: the previous lookup matched on id
      // alone, so it read across tenants and — once row-level security landed —
      // ran with no tenant context at all. `findProjectInOrg` supplies both.
      const project = organizationId ? await findProjectInOrg(id, organizationId) : null
      if (showResearchInHistory) {
        projectCollection = project?.collectionName ?? null
      }
      projectName = project?.name ?? null
    } catch {
      // Fail open: the affordances degrade rather than blanking chat.
    }

    return (
      <ProjectChatClient
        projectId={id}
        showSourceBadges={showSourceBadges}
        showConfidenceChip={showConfidenceChip}
        showAnswerFeedback={showAnswerFeedback}
        showResearchInHistory={showResearchInHistory}
        projectCollection={projectCollection}
        projectName={projectName}
        canCollaborate={canCollaborate}
        canChatInProject={canChatInProject}
      />
    )
  })
}

export default ProjectChatPage
