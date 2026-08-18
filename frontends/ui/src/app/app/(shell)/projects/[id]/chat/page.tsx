import { type ReactNode } from 'react'
import { getGridSession } from '@/lib/auth/session'
import { runWithTenantSlot } from '@/lib/db/tenant-context'
import { FEATURE_FLAGS, isCollaborationEnabled, isFeatureEnabled } from '@/lib/authz/feature-flags'
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
    try {
      const session = await getGridSession()
      if (session) {
        organizationId = session.organizationId
        showSourceBadges = isFeatureEnabled(session, FEATURE_FLAGS.sourceOriginBadges)
        showConfidenceChip = isFeatureEnabled(session, FEATURE_FLAGS.chatConfidenceChip)
        showResearchInHistory = isFeatureEnabled(session, FEATURE_FLAGS.researchInChatHistory)
        showAnswerFeedback = isFeatureEnabled(session, FEATURE_FLAGS.answerFeedback)
        canCollaborate = isCollaborationEnabled(session)
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
      />
    )
  })
}

export default ProjectChatPage
