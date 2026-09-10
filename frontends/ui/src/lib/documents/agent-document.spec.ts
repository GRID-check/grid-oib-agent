/**
 * @vitest-environment node
 */
/**
 * The `agent_document` producer (ADR-0054).
 *
 * The renderer's assertion is the one that matters, and it is on the STRING:
 * Markdown carries no metadata, so a marking that is not in the prose is not in
 * the file — and `fileGeneratedDocument` refuses a rendering whose marking it
 * cannot find in the bytes, which is what makes that a gate rather than a
 * convention. Two of the three earlier producers shipped unmarked precisely
 * because every assertion available was about the object that described the
 * file rather than about the file.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./generated', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./generated')>()),
  fileGeneratedDocument: vi.fn(),
}))
vi.mock('./lifecycle', () => ({ createDocumentVersion: vi.fn() }))
vi.mock('./repository', () => ({ findDocumentInOrg: vi.fn() }))
vi.mock('./version-repository', () => ({ findOpenVersion: vi.fn() }))

import { aiProvenanceMarking, markingIsInBytes } from '@/lib/ai-provenance'
import { makeDocument } from '@/test-utils/db-fixtures'
import type { AuthorizedSession } from '@/lib/auth/types'
import { fileGeneratedDocument } from './generated'
import { createDocumentVersion } from './lifecycle'
import { findDocumentInOrg } from './repository'
import { findOpenVersion } from './version-repository'
import {
  AGENT_DOCUMENT_MEDIA_TYPE,
  fileAgentDocumentDraft,
  renderAgentDocumentMarkdown,
} from './agent-document'
import { GENERATED_DOCUMENT_PRODUCER_REF_KINDS } from './generated'

const session = { userId: 'user_1', organizationId: 'org_1', email: 'a@grid.test' } as AuthorizedSession

describe('renderAgentDocumentMarkdown', () => {
  const marking = aiProvenanceMarking({})

  it('puts the marking IN the bytes, which is the only place Markdown has', () => {
    const rendered = renderAgentDocumentMarkdown('# Aktenvermerk\n\nGK 4.', marking)
    expect(markingIsInBytes(rendered.bytes, marking)).toBe(true)
    expect(rendered.contentType).toBe(AGENT_DOCUMENT_MEDIA_TYPE)
  })

  it('keeps the marking as visible text, not as a comment a paste would drop', () => {
    const text = new TextDecoder().decode(
      renderAgentDocumentMarkdown('# Aktenvermerk', marking).bytes,
    )
    // Inside a fenced block, after the body. A `<!-- … -->` wrapper survives the
    // byte check and dies on the first "paste as plain text".
    expect(text).toMatch(/```\nAIGenerated=true;/)
    expect(text.indexOf('# Aktenvermerk')).toBeLessThan(text.indexOf('AIGenerated=true'))
  })

  it('keeps the model’s own body intact', () => {
    const text = new TextDecoder().decode(
      renderAgentDocumentMarkdown('# Titel\n\n- eins\n- zwei', marking).bytes,
    )
    expect(text).toContain('- eins\n- zwei')
  })
})

describe('the producer is registered', () => {
  it('files under a reference kind that is not a run, because it is not one', () => {
    // `{conversation id}-{slug}` is not in the job store. Writing it into
    // `AIRunId` is the mistake migration 0066 exists to end.
    expect(GENERATED_DOCUMENT_PRODUCER_REF_KINDS.agent_document).toBe('answer_artifact')
  })
})

describe('fileAgentDocumentDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(findDocumentInOrg).mockResolvedValue(makeDocument({ id: 'doc_1' }))
    vi.mocked(createDocumentVersion).mockResolvedValue({ id: 'ver_1' } as never)
  })

  it('files the item first, then records version 1 as a draft', async () => {
    vi.mocked(fileGeneratedDocument).mockResolvedValue({
      documentId: 'doc_1',
      filename: 'aktenvermerk-2026-09-10.md',
      folderId: 'fold_1',
      alreadyFiled: false,
    })

    const result = await fileAgentDocumentDraft({
      session,
      projectId: 'proj_1',
      ref: 's_conv_1-aktenvermerk',
      title: 'Aktenvermerk',
      content: '# Aktenvermerk',
    })

    expect(fileGeneratedDocument).toHaveBeenCalledWith(
      expect.objectContaining({ producer: 'agent_document', ref: 's_conv_1-aktenvermerk' }),
    )
    expect(createDocumentVersion).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ op: 'create' }),
    )
    expect(result).toMatchObject({ documentId: 'doc_1', alreadyFiled: false })
  })

  it('does not fork a second draft when the reference was already filed', async () => {
    // A retried turn must get the draft it wrote, not another one. Revising is a
    // different gesture with a different route.
    vi.mocked(fileGeneratedDocument).mockResolvedValue({
      documentId: 'doc_1',
      filename: 'aktenvermerk-2026-09-10.md',
      folderId: 'fold_1',
      alreadyFiled: true,
    })
    vi.mocked(findOpenVersion).mockResolvedValue({ id: 'ver_existing' } as never)

    const result = await fileAgentDocumentDraft({
      session,
      projectId: 'proj_1',
      ref: 's_conv_1-aktenvermerk',
      title: 'Aktenvermerk',
      content: '# Aktenvermerk',
    })

    expect(createDocumentVersion).not.toHaveBeenCalled()
    expect(result).toMatchObject({ alreadyFiled: true, version: { id: 'ver_existing' } })
  })
})
