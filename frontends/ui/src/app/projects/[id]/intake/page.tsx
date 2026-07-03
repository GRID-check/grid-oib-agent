// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { eq } from 'drizzle-orm'
import { redirect } from 'next/navigation'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { ProjectIntakeWizard } from '@/features/projects/components/project-intake-wizard'

interface IntakePageProps {
  params: Promise<{ id: string }>
}

export default async function IntakePage({ params }: IntakePageProps): Promise<JSX.Element> {
  const session = await requireAuthorizedSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:view')

  const db = getDb()
  const [project] = await db
    .select({ profilePromptView: projects.profilePromptView })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1)

  if (project?.profilePromptView) {
    redirect(`/projects/${id}`)
  }

  return <ProjectIntakeWizard projectId={id} />
}
