/**
 * The two service halves of a stored raster: the presigned PUT the ingest
 * pipeline writes through, and the derived key the `view_knowledge_image`
 * tool reads back. Both build the key from the document's OWN row, so the
 * assertions here are about where the key can and cannot land.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { PutObjectCommand } from '@aws-sdk/client-s3'

vi.mock('@/lib/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/s3')>()),
  s3Client: { send: vi.fn() },
  signingS3Client: { send: vi.fn() },
  bucketAdminS3Client: { send: vi.fn() },
}))

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://seaweedfs.internal/presigned-put'),
}))

vi.mock('@/lib/storage/bucket', () => ({
  resolveDocumentBucket: (bucket: string | null) => bucket ?? 'grid-documents',
  ensureTenantBucketChecked: vi.fn(),
}))

vi.mock('./repository', () => ({
  findStorageKeyByIdAndCollection: vi.fn(),
  findStorageKeyByCollectionAndFilename: vi.fn(),
}))

import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { MAX_STORED_IMAGES_PER_DOCUMENT } from '@/lib/s3'
import { findStorageKeyByCollectionAndFilename, findStorageKeyByIdAndCollection } from './repository'
import { findDocumentImageStorageKey, presignDocumentImageUpload } from './service'

const DOC_ID = '4f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f'
const row = { storageKey: 'org/o1/project/p1/doc/d1/plan.pdf', storageBucket: 'grid-org-o1-abcdef123456' }

afterEach(() => {
  vi.clearAllMocks()
})

describe('presignDocumentImageUpload', () => {
  it('signs a PUT for <doc dir>/_img/<index>.jpg in the document bucket and returns the key', async () => {
    vi.mocked(findStorageKeyByIdAndCollection).mockResolvedValue(row)

    const slot = await presignDocumentImageUpload(DOC_ID, 'proj_1', 2, 'org_1')

    expect(slot).toEqual({
      uploadUrl: 'https://seaweedfs.internal/presigned-put',
      storageKey: 'org/o1/project/p1/doc/d1/_img/2.jpg',
    })
    expect(vi.mocked(findStorageKeyByIdAndCollection).mock.calls[0]).toEqual([DOC_ID, 'proj_1', 'org_1'])
    const [, command] = vi.mocked(getSignedUrl).mock.calls[0]
    expect(command).toBeInstanceOf(PutObjectCommand)
    expect((command as PutObjectCommand).input).toEqual({
      Bucket: 'grid-org-o1-abcdef123456',
      Key: 'org/o1/project/p1/doc/d1/_img/2.jpg',
      ContentType: 'image/jpeg',
    })
  })

  it('issues nothing for an unknown document', async () => {
    vi.mocked(findStorageKeyByIdAndCollection).mockResolvedValue(null)

    await expect(presignDocumentImageUpload(DOC_ID, 'proj_1', 0)).resolves.toBeNull()
    expect(getSignedUrl).not.toHaveBeenCalled()
  })

  // The ceiling is enforced where the write capability is minted: past it no
  // URL exists, so the backend has nothing to PUT with.
  it('issues nothing at or past the per-document ceiling', async () => {
    vi.mocked(findStorageKeyByIdAndCollection).mockResolvedValue(row)

    await expect(presignDocumentImageUpload(DOC_ID, 'proj_1', MAX_STORED_IMAGES_PER_DOCUMENT)).resolves.toBeNull()
    expect(getSignedUrl).not.toHaveBeenCalled()
  })
})

describe('findDocumentImageStorageKey', () => {
  it('derives the raster key from the owning row, never from the caller', async () => {
    vi.mocked(findStorageKeyByCollectionAndFilename).mockResolvedValue({ ...row, contentType: 'application/pdf' })

    await expect(findDocumentImageStorageKey('proj_1', 'plan.pdf', 5)).resolves.toEqual({
      storageKey: 'org/o1/project/p1/doc/d1/_img/5.jpg',
      storageBucket: 'grid-org-o1-abcdef123456',
      contentType: 'image/jpeg',
    })
  })

  it('answers null for an unknown pair or an index past the ceiling', async () => {
    vi.mocked(findStorageKeyByCollectionAndFilename).mockResolvedValue(null)
    await expect(findDocumentImageStorageKey('proj_1', 'plan.pdf', 0)).resolves.toBeNull()

    vi.mocked(findStorageKeyByCollectionAndFilename).mockResolvedValue({ ...row, contentType: 'application/pdf' })
    await expect(findDocumentImageStorageKey('proj_1', 'plan.pdf', MAX_STORED_IMAGES_PER_DOCUMENT)).resolves.toBeNull()
  })
})
