/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'

vi.mock('server-only', () => ({}))

const send = vi.fn()
vi.mock('@/lib/s3', async () => {
  const actual = await vi.importActual<typeof import('@/lib/s3')>('@/lib/s3')
  return { ...actual, s3Client: { send: (...args: unknown[]) => send(...args) } }
})
vi.mock('@/lib/storage/bucket', () => ({
  resolveDocumentBucket: (bucket: string | null) => bucket ?? 'grid-documents',
}))
const deleteBimDerivedObjects = vi.fn()
vi.mock('@/lib/bim/service', () => ({
  deleteBimDerivedObjects: (...args: unknown[]) => deleteBimDerivedObjects(...args),
}))

const listDocumentVersionObjects = vi.fn()
vi.mock('./version-repository', () => ({
  listDocumentVersionObjects: (...args: unknown[]) => listDocumentVersionObjects(...args),
}))

import { UpstreamError } from '@/lib/api/errors'
import { deleteDerivedObjects, eraseDocumentObjectsOrKeepRow } from './object-cleanup'

const doc = {
  storageKey: 'org/org-1/project/proj-1/doc/doc-1/plan.pdf',
  storageBucket: 'test-bucket',
}

const deletedKeys = () =>
  send.mock.calls
    .map(([command]) => command)
    .filter((command): command is DeleteObjectCommand => command instanceof DeleteObjectCommand)
    .map((command) => command.input.Key)

const IMG_PREFIX = 'org/org-1/project/proj-1/doc/doc-1/_img/'

/** `send` answers a listing with these keys and every delete with success. */
const storedRasters = (keys: string[], { truncated = false }: { truncated?: boolean } = {}) => {
  let page = 0
  send.mockImplementation(async (command: unknown) => {
    if (!(command instanceof ListObjectsV2Command)) return {}
    page += 1
    if (truncated && page === 1) {
      return { Contents: keys.slice(0, 1).map((Key) => ({ Key })), IsTruncated: true, NextContinuationToken: 'p2' }
    }
    return { Contents: (truncated ? keys.slice(1) : keys).map((Key) => ({ Key })) }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  send.mockResolvedValue({})
  deleteBimDerivedObjects.mockResolvedValue(undefined)
  listDocumentVersionObjects.mockResolvedValue([])
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('deleteDerivedObjects', () => {
  it('removes the thumbnail and the BIM derivatives but leaves the file', async () => {
    await expect(deleteDerivedObjects(doc)).resolves.toEqual({ ok: true })

    expect(deletedKeys()).toEqual(['org/org-1/project/proj-1/doc/doc-1/_thumb.jpg'])
    expect(deleteBimDerivedObjects).toHaveBeenCalledWith(doc.storageKey, 'test-bucket')
  })

  it('reports a failure it could not complete', async () => {
    deleteBimDerivedObjects.mockRejectedValue(new Error('SeaweedFS 500'))

    const result = await deleteDerivedObjects(doc)

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/bim derivatives/)
  })

  // The rasters are cut out of the private file, so leaving them behind after
  // "delete" is a disclosure. The count is only known by listing, hence the
  // prefix sweep rather than a fixed sibling name.
  it('sweeps the _img/ prefix the ingest pipeline stored rasters under', async () => {
    storedRasters([`${IMG_PREFIX}0.jpg`, `${IMG_PREFIX}1.jpg`])

    await expect(deleteDerivedObjects(doc)).resolves.toEqual({ ok: true })

    const listed = send.mock.calls.map(([c]) => c).find((c): c is ListObjectsV2Command => c instanceof ListObjectsV2Command)
    expect(listed?.input).toMatchObject({ Bucket: 'test-bucket', Prefix: IMG_PREFIX })
    expect(deletedKeys()).toEqual([
      'org/org-1/project/proj-1/doc/doc-1/_thumb.jpg',
      `${IMG_PREFIX}0.jpg`,
      `${IMG_PREFIX}1.jpg`,
    ])
  })

  it('pages the raster listing to exhaustion', async () => {
    storedRasters([`${IMG_PREFIX}0.jpg`, `${IMG_PREFIX}1.jpg`], { truncated: true })

    await expect(deleteDerivedObjects(doc)).resolves.toEqual({ ok: true })

    expect(deletedKeys()).toContain(`${IMG_PREFIX}1.jpg`)
    const listings = send.mock.calls.map(([c]) => c).filter((c) => c instanceof ListObjectsV2Command)
    expect(listings).toHaveLength(2)
  })

  it('reports a raster it could not remove instead of moving on', async () => {
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof ListObjectsV2Command) return { Contents: [{ Key: `${IMG_PREFIX}0.jpg` }] }
      if (command instanceof DeleteObjectCommand && command.input.Key === `${IMG_PREFIX}0.jpg`) {
        throw new Error('SeaweedFS 500')
      }
      return {}
    })

    const result = await deleteDerivedObjects(doc)

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/stored rasters/)
    expect(deleteBimDerivedObjects).not.toHaveBeenCalled()
  })
})

/**
 * The project and Archiv deletes used to erase the live object by hand — the
 * file, `_thumb.jpg` and `_bim/`, never the `_img/` rasters — and to swallow
 * every failure before deleting the row. They share this now.
 */
describe('eraseDocumentObjectsOrKeepRow', () => {
  const live = { id: 'doc-1', ...doc }

  it('erases the live file, its thumbnail, its _img/ rasters and its _bim/ derivatives', async () => {
    storedRasters([`${IMG_PREFIX}0.jpg`, `${IMG_PREFIX}1.jpg`])

    await eraseDocumentObjectsOrKeepRow(live, 'org-1')

    expect(deletedKeys()).toEqual([
      doc.storageKey,
      'org/org-1/project/proj-1/doc/doc-1/_thumb.jpg',
      `${IMG_PREFIX}0.jpg`,
      `${IMG_PREFIX}1.jpg`,
    ])
    expect(deleteBimDerivedObjects).toHaveBeenCalledWith(doc.storageKey, doc.storageBucket)
  })

  it("erases every superseded version's objects too, and does not stop on one that fails", async () => {
    const v2Key = 'org/org-1/project/proj-1/doc/doc-1/v2/plan.pdf'
    listDocumentVersionObjects.mockResolvedValue([
      { storageKey: doc.storageKey, storageBucket: doc.storageBucket },
      { storageKey: v2Key, storageBucket: doc.storageBucket },
    ])
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof DeleteObjectCommand && command.input.Key === v2Key) {
        throw Object.assign(new Error('boom'), { $metadata: { httpStatusCode: 500 } })
      }
      return {}
    })

    await expect(eraseDocumentObjectsOrKeepRow(live, 'org-1')).resolves.toBeUndefined()

    expect(listDocumentVersionObjects).toHaveBeenCalledWith('doc-1', 'org-1')
    expect(deletedKeys()).toContain(v2Key)
    expect(deletedKeys()).toContain(doc.storageKey)
  })

  it('throws, so the caller keeps the row, when the live file could not be erased', async () => {
    send.mockRejectedValue(Object.assign(new Error('SlowDown'), { $metadata: { httpStatusCode: 503 } }))

    await expect(eraseDocumentObjectsOrKeepRow(live, 'org-1')).rejects.toBeInstanceOf(UpstreamError)
  })

  it('throws when only a derivative could not be erased — a raster is the document too', async () => {
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof ListObjectsV2Command) throw new Error('listing refused')
      return {}
    })

    await expect(eraseDocumentObjectsOrKeepRow(live, 'org-1')).rejects.toBeInstanceOf(UpstreamError)
  })
})
