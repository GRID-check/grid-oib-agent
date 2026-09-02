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

import { deleteDerivedObjects, discardSupersededObjects } from './object-cleanup'

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

describe('discardSupersededObjects', () => {
  it('keeps the file when the new bytes landed on the same key', async () => {
    await discardSupersededObjects(doc, doc.storageKey, 'documents')

    expect(deletedKeys()).not.toContain(doc.storageKey)
    expect(deletedKeys()).toContain('org/org-1/project/proj-1/doc/doc-1/_thumb.jpg')
    expect(deleteBimDerivedObjects).toHaveBeenCalled()
  })

  it('removes the file too when the re-upload moved it', async () => {
    await discardSupersededObjects(doc, 'org/org-1/project/proj-1/plaene/doc/doc-1/plan.pdf', 'documents')

    expect(deletedKeys()).toEqual([doc.storageKey, 'org/org-1/project/proj-1/doc/doc-1/_thumb.jpg'])
  })

  it('never throws: a leaked object is logged, not a failed upload', async () => {
    send.mockRejectedValue(new Error('SeaweedFS 500'))

    await expect(discardSupersededObjects(doc, doc.storageKey, 'archiv')).resolves.toBeUndefined()
    expect(console.error).toHaveBeenCalledWith('[archiv] failed to remove the superseded objects', expect.any(Object))
  })
})
