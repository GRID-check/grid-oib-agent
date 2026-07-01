// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { eq, and, desc } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { documents } from '@/lib/db/schema'
import { Text } from '@/adapters/ui'
import { DocumentList } from '@/features/documents/components/document-list'

interface ProjectPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectPage({ params }: ProjectPageProps): Promise<JSX.Element> {
  const session = await requireAuthorizedSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:view')

  const db = getDb()

  const docRows = await db
    .select({
      id: documents.id,
      filename: documents.filename,
      fileSize: documents.fileSize,
      contentType: documents.contentType,
      status: documents.status,
      createdAt: documents.createdAt,
      errorMessage: documents.errorMessage,
    })
    .from(documents)
    .where(
      and(
        eq(documents.projectId, id),
        eq(documents.organizationId, session.organizationId),
      )
    )
    .orderBy(desc(documents.createdAt))

  return (
    <main className="container mx-auto px-4 py-8">
      <div className="rounded-lg border p-6">
        <Text kind="label/bold/sm" className="mb-4 text-primary uppercase">
          Documents ({docRows.length})
        </Text>
        <DocumentList documents={docRows} />
      </div>
    </main>
  )
}
