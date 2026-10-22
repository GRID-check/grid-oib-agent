/**
 * @vitest-environment node
 */
/**
 * What a thread view names is the reader's (D9, D36): every attachment of a
 * message is listed by position, and one filed where the reader may not look
 * keeps its place and loses its name and ids.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({}))
vi.mock('@/lib/authz/folder-access', () => ({}))
vi.mock('@/lib/authz/projects', () => ({}))
vi.mock('@/lib/inbound-mail/access', () => ({}))

import { attachmentViews } from './service'
import type { EntryAttachment } from './repository'

const HIDDEN = '5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c'
const attachment = (overrides: Partial<EntryAttachment>): EntryAttachment => ({
  entryId: 'e',
  position: 1,
  filename: 'S-101_C.pdf',
  disposition: 'filed',
  notFiledReason: null,
  documentId: 'doc-1',
  documentVersionId: null,
  document: { folderId: null },
  ...overrides,
})

describe('an entry’s attachments for the reader', () => {
  it('names what the reader may open, and what was not filed', () => {
    expect(
      attachmentViews(
        [attachment({}), attachment({ position: 2, filename: 'Plan.dwg', disposition: 'not_filed', notFiledReason: 'type_not_accepted', documentId: null, document: null })],
        new Set(),
      ),
    ).toEqual([
      { position: 1, filename: 'S-101_C.pdf', disposition: 'filed', documentId: 'doc-1', visible: true },
      { position: 2, filename: 'Plan.dwg', disposition: 'not_filed', notFiledReason: 'type_not_accepted', visible: true },
    ])
  })

  it('keeps the place of one filed where the reader may not look, without its name or ids', () => {
    expect(attachmentViews([attachment({ document: { folderId: HIDDEN } })], new Set([HIDDEN]))).toEqual([
      { position: 1, filename: null, disposition: 'filed', visible: false },
    ])
  })

  it('hides a filed attachment whose document is gone, held or binned', () => {
    expect(attachmentViews([attachment({ document: null })], new Set())).toEqual([{ position: 1, filename: null, disposition: 'filed', visible: false }])
  })
})
