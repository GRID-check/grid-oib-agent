/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const send = vi.fn()
vi.mock('@/lib/s3', () => ({ s3Client: { send: (cmd: unknown) => send(cmd) }, bucketAdminS3Client: {} }))
vi.mock('@/lib/storage/bucket', () => ({ ensureTenantBucketChecked: vi.fn(async () => 'grid-org-a') }))

import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { deleteStagedObjects, errorName, stageAttachments, stagingPrefix } from './staging'
import type { SelectedAttachment } from './types'

const attachment = (filename: string): SelectedAttachment => ({
  filename,
  contentType: 'application/pdf',
  content: new TextEncoder().encode(filename),
  sha256: 'a'.repeat(64),
})
const where = { organizationId: 'org_A', projectId: 'project-a', deliveryId: 'row-1' }

beforeEach(() => {
  send.mockReset()
  send.mockResolvedValue({})
})

describe('stageAttachments', () => {
  it('writes each attachment under the project prefix, numbered, into the organization’s bucket', async () => {
    const result = await stageAttachments(where, [attachment('Plan.pdf'), attachment('Statik.pdf')])
    expect(stagingPrefix('org_A', 'project-a', 'row-1')).toBe('org/org_A/project/project-a/inbound-mail/row-1/')
    expect(result.bucket).toBe('grid-org-a')
    expect(result.staged.map((s) => [s.key, s.filename, s.size])).toEqual([
      ['org/org_A/project/project-a/inbound-mail/row-1/1', 'Plan.pdf', 8],
      ['org/org_A/project/project-a/inbound-mail/row-1/2', 'Statik.pdf', 10],
    ])
    const puts = send.mock.calls.map(([cmd]) => cmd).filter((cmd) => cmd instanceof PutObjectCommand)
    expect(puts.map((cmd) => cmd.input.Bucket)).toEqual(['grid-org-a', 'grid-org-a'])
  })

  it('writes nothing, and needs no bucket, for a mail with nothing to file', async () => {
    expect(await stageAttachments(where, [])).toEqual({ bucket: null, staged: [] })
    expect(send).not.toHaveBeenCalled()
  })

  it('takes back what it wrote when a later write fails, then answers 502 (a retry)', async () => {
    send.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof PutObjectCommand && String(cmd.input.Key).endsWith('/2')) throw new Error('SlowDown')
      return {}
    })
    await expect(stageAttachments(where, [attachment('a'), attachment('b')])).rejects.toMatchObject({ status: 502 })
    const deletes = send.mock.calls.map(([cmd]) => cmd).filter((cmd) => cmd instanceof DeleteObjectCommand)
    expect(deletes.map((cmd) => cmd.input.Key)).toEqual(['org/org_A/project/project-a/inbound-mail/row-1/1'])
  })
})

describe('deleteStagedObjects', () => {
  it('returns what could not be deleted, and counts an object already gone as deleted', async () => {
    const [a, b, c] = (await stageAttachments(where, [attachment('a'), attachment('b'), attachment('c')])).staged
    send.mockReset()
    send
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))
      .mockRejectedValueOnce(Object.assign(new Error('InternalError'), { $metadata: { httpStatusCode: 500 } }))
    expect(await deleteStagedObjects('grid-org-a', [a, b, c])).toEqual([c])
  })
})

describe('errorName', () => {
  it('names the class and code, never the message', () => {
    const drizzle = Object.assign(new Error('Failed query: … params: anna@buero-a.at'), {
      cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
    })
    expect(errorName(drizzle)).toBe('Error:23505')
    expect(errorName('x')).toBe('string')
  })
})
