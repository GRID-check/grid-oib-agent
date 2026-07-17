import { type ReactNode } from 'react'
import { eq } from 'drizzle-orm'
import { getGridSession } from '@/lib/auth/session'
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
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
 * All fail open (visible) when enforcement is off. The project layout already
 * guards auth/access, so reaching here implies an authorized session; session
 * lookup is still wrapped defensively so a transient failure never blanks chat.
 */
const ProjectChatPage = async ({ params }: ProjectChatPageProps): Promise<ReactNode> => {
  const { id } = await params

  let showSourceBadges = true
  let showConfidenceChip = true
  let showResearchInHistory = true
  try {
    const session = await getGridSession()
    if (session) {
      showSourceBadges = isFeatureEnabled(session, FEATURE_FLAGS.sourceOriginBadges)
      showConfidenceChip = isFeatureEnabled(session, FEATURE_FLAGS.chatConfidenceChip)
      showResearchInHistory = isFeatureEnabled(session, FEATURE_FLAGS.researchInChatHistory)
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
    const db = getDb()
    const [project] = await db
      .select({ collectionName: projects.collectionName, name: projects.name })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1)
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
      showResearchInHistory={showResearchInHistory}
      projectCollection={projectCollection}
      projectName={projectName}
    />
  )
}

export default ProjectChatPage
