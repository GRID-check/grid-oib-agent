import { NextRequest, NextResponse } from 'next/server'
import { and, eq, desc } from 'drizzle-orm'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'
import { documents } from '@/lib/db/schema'

export async function GET(request: NextRequest): Promise<Response> {
  try {
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
        folderId: documents.folderId,
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
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
