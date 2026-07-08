import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'
import { documents } from '@/lib/db/schema'
import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'

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

    // Pending rows are lazily reconciled with the backend's ingestion state;
    // without this they would stay 'pending' forever (no completion callback).
    const [reconciled] = await reconcileDocumentStatuses([row])

    return NextResponse.json({
      id: reconciled.id,
      status: reconciled.status,
      filename: reconciled.filename,
      fileSize: reconciled.fileSize,
      contentType: reconciled.contentType,
      collectionName: reconciled.collectionName,
      errorMessage: reconciled.errorMessage,
      createdAt: reconciled.createdAt,
      updatedAt: reconciled.updatedAt,
    })
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
