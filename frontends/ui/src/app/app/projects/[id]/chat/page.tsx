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

  // The Deep Research section scopes its job fetch to this project's Qdrant
  // collection (the same identifier the runs list uses). Looked up here so the
  // client panel can pass it straight to listResearchRuns. Fail-soft: a missing
  // collection just yields an unscoped/empty section, never a broken chat.
  let projectCollection: string | null = null
  if (showResearchInHistory) {
    try {
      const db = getDb()
      const [project] = await db
        .select({ collectionName: projects.collectionName })
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1)
      projectCollection = project?.collectionName ?? null
    } catch {
      // Fail open: the section degrades to empty rather than blanking chat.
    }
  }

  return (
    <ProjectChatClient
      projectId={id}
      showSourceBadges={showSourceBadges}
      showConfidenceChip={showConfidenceChip}
      showResearchInHistory={showResearchInHistory}
      projectCollection={projectCollection}
    />
  )
}

export default ProjectChatPage
