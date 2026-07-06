import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'
import { documents } from '@/lib/db/schema'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { id } = await params
    const db = getDb()

    const [row] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)

    if (!row || row.organizationId !== session.organizationId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json({
      id: row.id,
      status: row.status,
      filename: row.filename,
      fileSize: row.fileSize,
      contentType: row.contentType,
      collectionName: row.collectionName,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
