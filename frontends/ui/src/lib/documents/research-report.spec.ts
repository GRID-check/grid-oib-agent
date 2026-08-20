/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const fileGeneratedDocument = vi.fn()
vi.mock('./generated', () => ({
  fileGeneratedDocument: (...args: unknown[]) => fileGeneratedDocument(...args),
}))

const buildAnswerDocument = vi.fn((..._args: unknown[]): unknown[] => [])
vi.mock('@/lib/answer-export/answer-document', () => ({
  buildAnswerDocument: (...args: unknown[]) => buildAnswerDocument(...args),
}))

const renderDocx = vi.fn((..._args: unknown[]): Uint8Array => new Uint8Array([9, 9]))
vi.mock('@/lib/answer-export/docx', () => ({
  renderDocx: (...args: unknown[]) => renderDocx(...args),
  DOCX_MEDIA_TYPE:
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}))

vi.mock('@/i18n/server', () => ({
  getTranslations: async () => (key: string) => `t:${key}`,
  getLocale: async () => 'de',
}))

import type { AuthorizedSession } from '@/lib/auth/types'
import type { GeneratedRenderContext } from './generated'
import { fileResearchReport, splitReportTitle } from './research-report'

const SESSION = { userId: 'user-1', organizationId: 'org-1' } as AuthorizedSession

const REPORT = '# Brandschutz Straßenhäuser\n\nDer Bericht beginnt hier.\n'

/** Run the renderer the caller handed to the service. */
const runRenderer = () => {
  const input = fileGeneratedDocument.mock.calls[0][0]
  const context: GeneratedRenderContext = { projectId: 'proj-1', projectName: 'Haus Anna' }
  return input.render(context)
}

beforeEach(() => {
  vi.clearAllMocks()
  fileGeneratedDocument.mockResolvedValue({
    documentId: 'doc-1',
    filename: 'brandschutz-2026-08-20.docx',
    folderId: 'folder-1',
    alreadyFiled: false,
  })
})

describe('splitReportTitle', () => {
  it('takes the report’s own H1 as the title and removes it from the body', () => {
    expect(splitReportTitle(REPORT)).toEqual({
      title: 'Brandschutz Straßenhäuser',
      body: 'Der Bericht beginnt hier.\n',
    })
  })

  it('leaves a report without a heading untouched rather than inventing a title', () => {
    const plain = 'Der Bericht beginnt sofort.'
    expect(splitReportTitle(plain)).toEqual({ title: null, body: plain })
  })

  it('does not mistake a deeper heading for the document title', () => {
    const report = '## Abschnitt\n\nText.'
    expect(splitReportTitle(report).title).toBeNull()
  })
})

describe('fileResearchReport', () => {
  it('files through the one service function, as the deep_research producer', async () => {
    await fileResearchReport({ session: SESSION, projectId: 'proj-1', runId: 'run_7', report: REPORT })

    const input = fileGeneratedDocument.mock.calls[0][0]
    expect(input.producer).toBe('deep_research')
    expect(input.runId).toBe('run_7')
    expect(input.projectId).toBe('proj-1')
    expect(input.title).toBe('Brandschutz Straßenhäuser')
  })

  it('falls back to the export’s own title when the report has no heading', async () => {
    await fileResearchReport({ session: SESSION, projectId: 'proj-1', runId: 'run_7', report: 'Text.' })
    expect(fileGeneratedDocument.mock.calls[0][0].title).toBe('t:documentTitle')
  })

  /**
   * The two markings are independent by design — one is read by a person on
   * page one, the other is detected by a records system without OCR — so a
   * caller that sets one and not the other ships a document that is marked for
   * exactly one of its two audiences. This caller owns passing both.
   */
  it('sets the printed notice AND the machine-readable provenance', async () => {
    await fileResearchReport({ session: SESSION, projectId: 'proj-1', runId: 'run_7', report: REPORT })
    const rendering = await runRenderer()

    expect(buildAnswerDocument.mock.calls[0][0]).toMatchObject({
      agentAuthored: true,
      projectName: 'Haus Anna',
      conversationTitle: 'Brandschutz Straßenhäuser',
      answer: 'Der Bericht beginnt hier.\n',
    })
    expect(renderDocx.mock.calls[0][1]).toEqual({ aiProvenance: { runId: 'run_7' } })
    expect(rendering.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
  })

  it('renders nothing until the service asks for it', async () => {
    await fileResearchReport({ session: SESSION, projectId: 'proj-1', runId: 'run_7', report: REPORT })
    expect(renderDocx).not.toHaveBeenCalled()
  })
})
