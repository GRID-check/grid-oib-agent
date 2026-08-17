import { describe, expect, it } from 'vitest'
import { documentAskQuestion, documentFilesHref, documentQuestionHref, fileItemFromStatus } from './document-question'

describe('documentAskQuestion', () => {
  it('names the file so the agent can retrieve it', () => {
    expect(documentAskQuestion('Brandschutz.pdf')).toContain('Brandschutz.pdf')
    expect(documentAskQuestion('Brandschutz.pdf', 'keyPoints')).toContain('Brandschutz.pdf')
    expect(documentAskQuestion('Brandschutz.pdf', 'oib')).toContain('Brandschutz.pdf')
  })
})

describe('documentQuestionHref', () => {
  it('opens chat with the file as subject and no canned question', () => {
    expect(documentQuestionHref('proj-1', 'doc-9')).toBe(
      '/app/projects/proj-1/chat?new=1&doc=doc-9',
    )
  })

  it('carries an opt-in starter question', () => {
    const href = new URL(documentQuestionHref('proj-1', 'doc-9', { ask: 'Was sind die Kernaussagen?' }), 'https://grid.test')
    expect(href.searchParams.get('doc')).toBe('doc-9')
    expect(href.searchParams.get('ask')).toBe('Was sind die Kernaussagen?')
  })

  it('carries the filename as retrieval identity, not as a canned question', () => {
    const href = new URL(documentQuestionHref('proj-1', 'doc-9', { filename: 'Brandschutz.pdf' }), 'https://grid.test')
    expect(href.searchParams.get('file')).toBe('Brandschutz.pdf')
    expect(href.searchParams.get('ask')).toBeNull()
  })

  it('keeps the filename when a starter question is also set', () => {
    const href = new URL(
      documentQuestionHref('proj-1', 'doc-9', { ask: 'Fass den Inhalt zusammen.', filename: 'Brandschutz.pdf' }),
      'https://grid.test',
    )
    expect(href.searchParams.get('doc')).toBe('doc-9')
    expect(href.searchParams.get('file')).toBe('Brandschutz.pdf')
    expect(href.searchParams.get('ask')).toBe('Fass den Inhalt zusammen.')
  })
})

describe('documentFilesHref', () => {
  it('deep-links the preview', () => {
    expect(documentFilesHref('proj-1', 'doc-9')).toBe('/app/projects/proj-1/files?doc=doc-9')
  })
})

describe('fileItemFromStatus', () => {
  it('fills the preview-shaped file from a status payload', () => {
    const file = fileItemFromStatus({
      id: 'doc-1',
      filename: 'plan.pdf',
      status: 'ready',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(file.id).toBe('doc-1')
    expect(file.filename).toBe('plan.pdf')
    expect(file.displayName).toBeNull()
    expect(file.folderId).toBeNull()
  })
})
