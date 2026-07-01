// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server'
import { and, eq, desc } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'
import { documents } from '@/lib/db/schema'

export async function GET(request: NextRequest): Promise<Response> {
  const session = await requireAuthorizedSession()
  const { searchParams } = new URL(request.url)
  const projectId = searchParams.get('projectId')

  if (!projectId) {
    return NextResponse.json({ error: 'projectId query parameter is required' }, { status: 400 })
  }

  const db = getDb()

  const rows = await db
    .select({
      id: documents.id,
      filename: documents.filename,
      fileSize: documents.fileSize,
      contentType: documents.contentType,
      status: documents.status,
      collectionName: documents.collectionName,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
      errorMessage: documents.errorMessage,
    })
    .from(documents)
    .where(
      and(
        eq(documents.projectId, projectId),
        eq(documents.organizationId, session.organizationId),
      )
    )
    .orderBy(desc(documents.createdAt))

  return NextResponse.json({ documents: rows })
}
