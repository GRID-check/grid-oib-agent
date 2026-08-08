import { describe, it, expect, vi } from 'vitest'
import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'

import { deleteStoragePrefix, isMissingBucket } from './storage.js'

/**
 * The prefix sweep is the step of the deletion pipeline (ADR-0011) that removes
 * a tenant's actual bytes, and it runs AFTER the Python-side stores have already
 * been destroyed. So both of its failure modes are asymmetric: reporting success
 * when objects survive is a GDPR erasure that did not happen, and reporting
 * failure when nothing is wrong strands the queue row with the purge half-done.
 *
 * It had no spec of its own. The pagination loop and the partial-failure throw —
 * the branch the module's own comment calls the GDPR-critical one — were covered
 * only through a mocked `deleteStoragePrefix` in the caller's tests, i.e. not at
 * all.
 */

/** An S3 error as the SDK surfaces it. */
const s3Error = (name, status) =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } })

function makeS3(pages, { deleteResult = {} } = {}) {
  const send = vi.fn(async (command) => {
    if (command instanceof ListObjectsV2Command) {
      const next = pages.shift()
      if (next instanceof Error) throw next
      return next
    }
    if (command instanceof DeleteObjectsCommand) return deleteResult
    throw new Error(`unexpected command ${command.constructor.name}`)
  })
  return { send }
}

describe('deleteStoragePrefix', () => {
  it('deletes every page, following the continuation token', async () => {
    const s3 = makeS3([
      { Contents: [{ Key: 'a' }, { Key: 'b' }], IsTruncated: true, NextContinuationToken: 't1' },
      { Contents: [{ Key: 'c' }], IsTruncated: false },
    ])

    expect(await deleteStoragePrefix(s3, 'grid-documents', 'org/o1/project/p1/')).toBe(3)
    const listed = s3.send.mock.calls
      .map(([c]) => c)
      .filter((c) => c instanceof ListObjectsV2Command)
    expect(listed).toHaveLength(2)
    expect(listed[1].input.ContinuationToken).toBe('t1')
  })

  it('is a successful no-op on an empty prefix', async () => {
    const s3 = makeS3([{ Contents: [], IsTruncated: false }])
    expect(await deleteStoragePrefix(s3, 'grid-documents', 'org/o1/')).toBe(0)
    expect(s3.send.mock.calls.filter(([c]) => c instanceof DeleteObjectsCommand)).toHaveLength(0)
  })

  // The branch the module exists to get right. `Quiet: true` means a 200 can
  // still carry per-key errors; swallowing them makes the purge "succeed", the
  // grid_app pointer disappear, and the surviving objects unreachable orphans.
  it('throws when the batch delete reports per-key errors', async () => {
    const s3 = makeS3([{ Contents: [{ Key: 'a' }], IsTruncated: false }], {
      deleteResult: { Errors: [{ Key: 'a', Code: 'AccessDenied' }] },
    })
    await expect(deleteStoragePrefix(s3, 'grid-documents', 'org/o1/')).rejects.toThrow(
      /reported 1 error/,
    )
  })

  // Per-organization buckets are created LAZILY, on an organization's first
  // upload (ADR-0043). Any organization that has not uploaded since the feature
  // was enabled — or ever — has no tenant bucket, and the purge visits it
  // anyway because erasure must not depend on the current flag state. A bucket
  // that does not exist holds no objects, so this is the correct answer, not a
  // swallowed error: without it the purge fails AFTER destroying the
  // Python-side stores, retries ten times destroying them again, and then
  // abandons the row with the tenant's project and conversation data intact.
  it('treats a missing bucket as an empty sweep', async () => {
    const s3 = makeS3([s3Error('NoSuchBucket', 404)])
    expect(await deleteStoragePrefix(s3, 'grid-org-o1-abcdef123456', 'org/o1/')).toBe(0)
  })

  it('still propagates any other failure', async () => {
    // A 403 means the credential is wrong, not that the bucket is absent.
    // Treating it as "nothing to delete" would report an erasure that never
    // touched the objects.
    const s3 = makeS3([s3Error('AccessDenied', 403)])
    await expect(deleteStoragePrefix(s3, 'grid-documents', 'org/o1/')).rejects.toThrow(
      'AccessDenied',
    )
  })

  it('does not mistake a plain transport error for a missing bucket', async () => {
    const s3 = makeS3([new Error('ECONNREFUSED')])
    await expect(deleteStoragePrefix(s3, 'grid-documents', 'org/o1/')).rejects.toThrow(
      'ECONNREFUSED',
    )
  })
})

describe('isMissingBucket', () => {
  it.each([
    [s3Error('NoSuchBucket', 404), true],
    [s3Error('NotFound', 404), true],
    [s3Error('AccessDenied', 403), false],
    [new Error('ECONNREFUSED'), false],
    [undefined, false],
  ])('classifies %o', (error, expected) => {
    expect(isMissingBucket(error)).toBe(expected)
  })
})
