import { NextRequest, NextResponse } from 'next/server'
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { and, eq } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { s3Client, bucketName, buildMinioKey } from '@/lib/s3'
import { getDb } from '@/lib/db'
import { documents, projects, projectFolders } from '@/lib/db/schema'

const getBackendUrl = (): string => {
  const url = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000'
  return url.replace(/\/$/, '')
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()

    const formData = await request.formData()
    const projectId = formData.get('projectId') as string | null
    const folderId = formData.get('folderId') as string | null
    const file = formData.get('file') as File | null

    if (!projectId || !file) {
      return NextResponse.json({ error: 'projectId and file are required' }, { status: 400 })
    }

    await requireProjectAccess(session, projectId, 'project:edit')

    const db = getDb()

    let folderPath: string | null = null
    if (folderId) {
      const [folder] = await db
        .select({ path: projectFolders.path })
        .from(projectFolders)
        .where(
          and(
            eq(projectFolders.id, folderId),
            eq(projectFolders.projectId, projectId),
          )
        )
        .limit(1)
      if (!folder) {
        return NextResponse.json({ error: 'Folder not found in project' }, { status: 404 })
      }
      folderPath = folder.path
    }
    const [project] = await db
      .select({ collectionName: projects.collectionName })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, session.organizationId)))
      .limit(1)

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const documentId = uuidv4()
    const collectionName = project.collectionName
    const minioKey = buildMinioKey(session.organizationId, projectId, documentId, file.name, folderPath)

    const bytes = Buffer.from(await file.arrayBuffer())
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: minioKey,
        Body: bytes,
        ContentType: file.type || 'application/octet-stream',
      })
    )

    await db.insert(documents).values({
      id: documentId,
      organizationId: session.organizationId,
      projectId,
      folderId: folderId ?? null,
      createdBy: session.userId,
      filename: file.name,
      minioKey,
      collectionName,
      fileSize: file.size,
      contentType: file.type || null,
      status: 'uploaded',
    })

    const presignedUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: bucketName, Key: minioKey }),
      { expiresIn: Number(process.env.MINIO_PRESIGNED_URL_TTL_SECONDS || 600) }
    )

    let ingestJobId: string | null = null
    try {
      const ingestRes = await fetch(`${getBackendUrl()}/v1/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_ref: presignedUrl,
          collection: collectionName,
          document_id: documentId,
        }),
      })

      if (ingestRes.ok) {
        const ingestResult = await ingestRes.json()
        ingestJobId = ingestResult.job_id ?? null
      }
    } catch {
      // Ingestion call is best-effort; document is already in MinIO + DB
    }

    if (ingestJobId) {
      // The job id is persisted so status reads can reconcile the row with the
      // backend's ingestion state (see lib/documents/reconcile-status.ts).
      await db
        .update(documents)
        .set({ status: 'pending', metadata: { ingestJobId }, updatedAt: new Date() })
        .where(eq(documents.id, documentId))
    }

    return NextResponse.json({
      documentId,
      jobId: ingestJobId,
      status: ingestJobId ? 'pending' : 'uploaded',
      filename: file.name,
    })
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
