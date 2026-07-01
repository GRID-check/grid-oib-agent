// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { eq, asc } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { Button, Flex, Text } from '@/adapters/ui'
import { ProjectCard } from '@/components/projects/project-card'
import { CreateProjectForm } from '@/components/projects/create-project-form'

export default async function ProjectsPage(): Promise<JSX.Element> {
  const session = await requireAuthorizedSession()
  const db = getDb()

  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.organizationId, session.organizationId))
    .orderBy(asc(projects.createdAt))

  return (
    <main className="container mx-auto px-4 py-8">
      <Flex align="center" justify="between" className="mb-6">
        <Text kind="body/bold/2xl">Projects</Text>
        <Button kind="primary" size="small" disabled>
          Create project
        </Button>
      </Flex>

      {rows.length === 0 ? (
        <Flex direction="col" align="center" gap="4" className="py-12">
          <Text kind="body/regular/md" className="text-subtle">
            No projects yet. Create one to get started.
          </Text>
          <div className="w-full max-w-md rounded-lg border p-4">
            <CreateProjectForm />
          </div>
        </Flex>
      ) : (
        <>
          <div className="mb-6 rounded-lg border p-4">
            <CreateProjectForm />
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {rows.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        </>
      )}
    </main>
  )
}
