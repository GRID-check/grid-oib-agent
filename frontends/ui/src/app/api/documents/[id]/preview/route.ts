import { NextRequest, NextResponse } from 'next/server'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { eq } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { signingS3Client, bucketName } from '@/lib/s3'
import { getDb } from '@/lib/db'
import { documents } from '@/lib/db/schema'

const PREVIEW_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/tiff',
]

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { id } = await params

    const db = getDb()
    const [doc] = await db
      .select({
        minioKey: documents.minioKey,
        contentType: documents.contentType,
        filename: documents.filename,
        organizationId: documents.organizationId,
        projectId: documents.projectId,
      })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)

    if (!doc) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    if (doc.organizationId !== session.organizationId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const contentType = doc.contentType || 'application/octet-stream'
    if (!PREVIEW_CONTENT_TYPES.includes(contentType)) {
      return NextResponse.json(
        { error: 'Preview not available for this file type', contentType },
        { status: 415 },
      )
    }

    const presignedUrl = await getSignedUrl(
      signingS3Client,
      new GetObjectCommand({
        Bucket: bucketName,
        Key: doc.minioKey,
        ResponseContentDisposition: `inline; filename="${doc.filename}"`,
        ResponseContentType: contentType,
      }),
      { expiresIn: 3600 },
    )

    return NextResponse.json({ url: presignedUrl, contentType, filename: doc.filename })
  } catch (error) {
    console.error('GET /api/documents/[id]/preview error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
