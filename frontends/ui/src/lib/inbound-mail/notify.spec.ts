/**
 * @vitest-environment node
 */
/**
 * The sender's receipt, checked against the inbox registry's own params
 * schema (`assertInboxParams`), so an emission the inbox would refuse fails
 * here rather than in production.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn() }))

import type { Project } from '@/lib/db/schema'
import { assertInboxParams, INBOX_SKIPPED_FILES_MAX } from '@/lib/inbox/registry'
import { emitInboxItems, type InboxEmission } from '@/lib/inbox/service'
import { findProjectInOrg } from '@/lib/projects/repository'
import { notifyFailed, notifyFiled, skippedFilesForNotice } from './notify'

const row = {
  id: 'row-1',
  organizationId: 'org_A',
  projectId: 'project-a',
  senderUserId: 'user-anna',
  subject: 'Pläne Bauteil A',
  folderId: 'folder-1',
}

const emitted = (): InboxEmission => vi.mocked(emitInboxItems).mock.calls[0][0][0]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(emitInboxItems).mockResolvedValue(1)
  vi.mocked(findProjectInOrg).mockResolvedValue({ id: 'project-a', name: 'Wohnbau Hietzing' } as Project)
})

describe('notifyFiled', () => {
  it('sends the typed params the registry accepts, anchored on the delivery', async () => {
    await notifyFiled(row, {
      filed: 2,
      skipped: [{ filename: 'image001.png', reason: 'embedded' }, { reason: 'limit' }],
      folderId: 'folder-1',
    })
    const emission = emitted()
    expect(emission).toMatchObject({
      organizationId: 'org_A',
      recipientUserId: 'user-anna',
      type: 'inbound_mail.filed',
      resourceType: 'project',
      resourceId: 'project-a',
      anchorId: 'row-1',
      actorUserId: null,
    })
    expect(emission.payload).toEqual({
      subject: 'Pläne Bauteil A',
      folderId: 'folder-1',
      params: {
        filed: 2,
        skipped: 2,
        project: 'Wohnbau Hietzing',
        skippedFiles: [{ name: 'image001.png', reason: 'embedded' }],
      },
    })
    expect(() => assertInboxParams(emission.type, emission.payload?.params)).not.toThrow()
  })

  it('sends a null subject rather than a German placeholder', async () => {
    await notifyFiled({ ...row, subject: '  ' }, { filed: 0, skipped: [], folderId: null })
    expect(emitted().payload?.subject).toBeNull()
  })

  it('never fails the delivery when the inbox write fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(emitInboxItems).mockRejectedValue(new Error('Failed query: insert … anna@buero-a.at'))
    await expect(notifyFiled(row, { filed: 1, skipped: [], folderId: null })).resolves.toBeUndefined()
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).not.toContain('anna@')
  })
})

describe('notifyFailed', () => {
  it('sends inbound_mail.failed with the project, valid for its schema', async () => {
    await notifyFailed(row)
    const emission = emitted()
    expect(emission.type).toBe('inbound_mail.failed')
    expect(emission.payload).toEqual({ subject: 'Pläne Bauteil A', folderId: 'folder-1', params: { project: 'Wohnbau Hietzing' } })
    expect(() => assertInboxParams(emission.type, emission.payload?.params)).not.toThrow()
  })
})

describe('skippedFilesForNotice', () => {
  it('names at most ten, drops nameless entries, and cuts long names by grapheme', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ filename: `f${i}.png`, reason: 'embedded' }))
    expect(skippedFilesForNotice([{ reason: 'limit' }, ...many])).toHaveLength(INBOX_SKIPPED_FILES_MAX)
    const long = `${'👩‍👩‍👧'.repeat(60)}.pdf`
    const [cut] = skippedFilesForNotice([{ filename: long, reason: 'size' }])
    expect(cut.name.length).toBeLessThanOrEqual(120)
    expect(cut.name.endsWith('…')).toBe(true)
    expect(cut.name.slice(0, -1).length % '👩‍👩‍👧'.length).toBe(0)
  })
})
