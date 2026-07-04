import { NextRequest, NextResponse } from 'next/server'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { eq } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { signingS3Client, bucketName } from '@/lib/s3'
import { getDb } from '@/lib/db'
import { documents } from '@/lib/db/schema'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
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

  if (!row.minioKey) {
    return NextResponse.json({ error: 'File not available' }, { status: 404 })
  }

  const presignedUrl = await getSignedUrl(
    signingS3Client,
    new GetObjectCommand({
      Bucket: bucketName,
      Key: row.minioKey,
      ResponseContentDisposition: `attachment; filename="${row.filename}"`,
    }),
    { expiresIn: Number(process.env.MINIO_PRESIGNED_URL_TTL_SECONDS || 600) }
  )

  return NextResponse.json({
    downloadUrl: presignedUrl,
    filename: row.filename,
    contentType: row.contentType,
    fileSize: row.fileSize,
  })
}
