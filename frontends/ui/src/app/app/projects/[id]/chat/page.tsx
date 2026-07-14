import { type ReactNode } from 'react'
import { getGridSession } from '@/lib/auth/session'
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
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
 *   - `source-origin-badges` → ReportTab origin badges
 *   - `chat-confidence-chip`  → AgentResponse confidence chip
 * Both fail open (visible) when enforcement is off. The project layout already
 * guards auth/access, so reaching here implies an authorized session; session
 * lookup is still wrapped defensively so a transient failure never blanks chat.
 */
const ProjectChatPage = async ({ params }: ProjectChatPageProps): Promise<ReactNode> => {
  const { id } = await params

  let showSourceBadges = true
  let showConfidenceChip = true
  try {
    const session = await getGridSession()
    if (session) {
      showSourceBadges = isFeatureEnabled(session, FEATURE_FLAGS.sourceOriginBadges)
      showConfidenceChip = isFeatureEnabled(session, FEATURE_FLAGS.chatConfidenceChip)
    }
  } catch {
    // Fail open: a session-lookup problem must not hide chat affordances.
  }

  return (
    <ProjectChatClient
      projectId={id}
      showSourceBadges={showSourceBadges}
      showConfidenceChip={showConfidenceChip}
    />
  )
}

export default ProjectChatPage
