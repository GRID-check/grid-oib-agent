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
// The two reads the branding resolution makes. Stubbed rather than left to fail
// soft: both DO fail soft (see `loadOrganizationBrandingOverride`), but a spec
// that relied on that would be asserting the platform default by way of a
// database that is not there, and would go on passing if the override layer
// stopped being read at all.
vi.mock('@/lib/organizations/service', () => ({
  getOrgSettings: vi.fn(async () => ({ displayName: null, defaultLocale: 'de', settings: {} })),
  getOrganizationDisplayName: vi.fn(async () => 'Musterbüro ZT GmbH'),
}))
vi.mock('./lifecycle', () => ({ createDocumentVersion: vi.fn() }))
vi.mock('./repository', () => ({ findDocumentInOrg: vi.fn() }))
vi.mock('./version-repository', () => ({ findOpenVersion: vi.fn() }))

import { aiProvenanceMarking, markingIsInBytes } from '@/lib/ai-provenance'
import { PLATFORM_DOCUMENT_BRANDING, resolveDocumentBranding } from './branding'
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
  const branding = {
    productName: 'Piloti',
    tagline: PLATFORM_DOCUMENT_BRANDING.copy.de.tagline,
    headerLine: 'Erstellt mit Piloti für Musterbüro ZT GmbH',
    footerLine: 'Piloti · Entwurf, nicht freigegeben',
    prose: PLATFORM_DOCUMENT_BRANDING.copy.de.prose.replace('{product}', 'Piloti'),
    disclaimer: PLATFORM_DOCUMENT_BRANDING.copy.de.disclaimer,
    logo: null,
    aiGeneratorName: 'Piloti',
  }

  it('puts the marking IN the bytes, which is the only place Markdown has', () => {
    const rendered = renderAgentDocumentMarkdown('# Aktenvermerk\n\nGK 4.', marking, branding)
    expect(markingIsInBytes(rendered.bytes, marking)).toBe(true)
    expect(rendered.contentType).toBe(AGENT_DOCUMENT_MEDIA_TYPE)
  })

  it('keeps the marking as visible text, not as a comment a paste would drop', () => {
    const text = new TextDecoder().decode(
      renderAgentDocumentMarkdown('# Aktenvermerk', marking, branding).bytes,
    )
    // Inside a fenced block, after the body. A `<!-- … -->` wrapper survives the
    // byte check and dies on the first "paste as plain text".
    expect(text).toMatch(/```\nAIGenerated=true;/)
    expect(text.indexOf('# Aktenvermerk')).toBeLessThan(text.indexOf('AIGenerated=true'))
  })

  it('keeps the model’s own body intact', () => {
    const text = new TextDecoder().decode(
      renderAgentDocumentMarkdown('# Titel\n\n- eins\n- zwei', marking, branding).bytes,
    )
    expect(text).toContain('- eins\n- zwei')
  })

  it('carries the branding IN the bytes, which is the only place a file has', () => {
    // The byline in the preview pane is chrome and stays in the app. A file on
    // somebody's disk, or attached to an Einreichung, carries only what is
    // inside it — so every one of these four lines is asserted on the string.
    const text = new TextDecoder().decode(
      renderAgentDocumentMarkdown('# Aktenvermerk', marking, branding).bytes,
    )
    expect(text).toContain(branding.headerLine)
    expect(text).toContain(branding.prose)
    expect(text).toContain(branding.disclaimer)
    expect(text).toContain(branding.footerLine)
    expect(text).toContain(`${branding.productName} — ${branding.tagline}`)
  })

  it('puts the header line above the title and the disclaimer below the body', () => {
    // One line of chrome above, three sentences of liability below. The other
    // way round turns every preview and every paste into a disclaimer with a
    // document underneath it.
    const text = new TextDecoder().decode(
      renderAgentDocumentMarkdown('# Aktenvermerk\n\nGK 4.', marking, branding).bytes,
    )
    expect(text.indexOf(branding.headerLine)).toBeLessThan(text.indexOf('# Aktenvermerk'))
    expect(text.indexOf('GK 4.')).toBeLessThan(text.indexOf(branding.prose))
    expect(text.indexOf(branding.prose)).toBeLessThan(text.indexOf('AIGenerated=true'))
  })
})

describe('the filing seam resolves the branding once', () => {
  it('hands the renderer the platform copy in the document’s language', async () => {
    const branding = await resolveDocumentBranding({
      organizationId: 'org_1',
      organizationName: 'Musterbüro ZT GmbH',
      locale: 'de',
    })
    expect(branding.headerLine).toBe('Erstellt mit Piloti für Musterbüro ZT GmbH')
    expect(branding.aiGeneratorName).toBe('Piloti')
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
