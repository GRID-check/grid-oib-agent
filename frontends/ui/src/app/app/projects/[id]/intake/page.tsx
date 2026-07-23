import { type JSX } from 'react'
import { type Metadata } from 'next'
import { eq } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { deriveIntakeEntry } from '@/lib/project-profile/salvage'
import { getTranslations } from '@/i18n/server'
import { ProjectIntakeWizard } from '@/features/projects/components/project-intake-wizard'

interface IntakePageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('nav')
  return { title: t('tabTitle.intake') }
}

export default async function IntakePage({ params }: IntakePageProps): Promise<JSX.Element> {
  const session = await requireAuthorizedPageSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:view')

  const db = getDb()
  const [project] = await db
    .select({ name: projects.name, profile: projects.profile, profileVersion: projects.profileVersion })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1)

  if (!project) {
    notFound()
  }

  // Re-entry (edit mode): if a profile already exists, prefill the wizard from it
  // instead of bouncing back to Overview — Overview's "Edit brief" links depend on
  // this. A malformed stored profile is SALVAGED per-part (keep every well-formed
  // fact/goal/unknown/assumption, drop only the invalid entries) rather than
  // discarded whole: discarding it silently would let the next Save overwrite a
  // still-good brief with only the freshly-typed answers. Any surviving content —
  // including an assumptions-only brief — opens the wizard in edit mode prefilled
  // from the profile; when parts were dropped the wizard shows an honest banner.
  const { mode, initialProfile, salvageNotice } = deriveIntakeEntry(project.profile)

  // FB-13: the end-of-wizard conflict check is computed server-side from the
  // session's flags and prop-drilled — off → the wizard saves exactly as before.
  const conflictCheckEnabled = isFeatureEnabled(session, FEATURE_FLAGS.wizardConflictCheck)

  return (
    <ProjectIntakeWizard
      projectId={id}
      projectName={project.name}
      mode={mode}
      initialProfile={initialProfile}
      initialProfileVersion={project.profileVersion}
      conflictCheckEnabled={conflictCheckEnabled}
      salvageNotice={salvageNotice}
    />
  )
}
