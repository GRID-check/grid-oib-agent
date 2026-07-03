// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { eq } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { Flex, Text } from '@/adapters/ui'
import { Users } from '@/adapters/ui/icons'
import { ProjectMembersForm } from '@/components/projects/project-members-form'

interface ProjectMembersPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectMembersPage({ params }: ProjectMembersPageProps): Promise<JSX.Element> {
  const session = await requireAuthorizedSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:manage')

  const db = getDb()
  const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, id)).limit(1)

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 md:px-8">
      <section className="mb-6 rounded-[2rem] border border-base bg-surface-raised-30 p-6 shadow-[0_35px_100px_-75px_rgba(15,23,42,0.8)]">
        <Flex align="start" justify="between" gap="4" className="flex-col md:flex-row">
          <Flex gap="4" align="center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-base bg-surface-sunken text-brand">
              <Users className="h-7 w-7" />
            </div>
            <Flex direction="col" gap="2">
              <Text kind="body/regular/xs" className="text-subtle uppercase tracking-[0.24em]">
                access matrix
              </Text>
              <Text kind="body/bold/2xl" className="text-primary tracking-[-0.03em]">
                {project?.name ?? 'Project'} members
              </Text>
              <Text kind="body/regular/md" className="max-w-2xl text-subtle">
                Add organization members to this project by assigning a project role. Set no access to remove them from this workspace.
              </Text>
            </Flex>
          </Flex>
        </Flex>
      </section>
      <ProjectMembersForm projectId={id} />
    </main>
  )
}
