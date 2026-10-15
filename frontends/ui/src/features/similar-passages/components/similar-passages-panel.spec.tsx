/**
 * The rail of „Im Büro behandelt": what it says while searching, when nothing
 * was found, when the search failed and when the document is still being
 * screened; the answer in one line; the places in the order the reader asks
 * about them (this project, the other projects, the Büroablage); that no score
 * is shown; that the arrow keys walk the passages; and what opening one hands
 * the stage.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@/test-utils'

vi.mock('@/lib/analytics/posthog', () => ({ capturePosthog: vi.fn() }))

import { capturePosthog } from '@/lib/analytics/posthog'
import { SimilarPassagesError } from '@/lib/similar-passages/client'
import type { SimilarPassagesRequest, SimilarPassagesResponse } from '@/lib/similar-passages/types'
import type { SimilarPassagesLoader } from '../lib/use-similar-passages'
import { SimilarPassagesPanel } from './similar-passages-panel'

const REQUEST: SimilarPassagesRequest = {
  document: { kind: 'stored', documentId: 'doc-source' },
  passage: { text: 'Die Fluchttreppe wird als offene Außentreppe ausgeführt.', page: 4, cited: true },
  projectId: 'p-1',
}

const RESPONSE: SimilarPassagesResponse = {
  origin: 'point',
  projectsSearched: 3,
  groups: [
    {
      kind: 'current',
      project: { id: 'p-1', name: 'Wohnhaus Mödling', status: 'active' },
      documents: [
        {
          documentId: 'doc-a',
          filename: 'BSK.pdf',
          displayName: 'Brandschutzkonzept',
          contentType: 'application/pdf',
          stand: { kind: 'index', text: 'Index C' },
          passages: [
            { page: 3, snippet: 'Außentreppe in Stahlbeton', score: 0.91 },
            { page: 5, snippet: 'Laufbreite 1,20 m', score: 0.84 },
          ],
        },
      ],
    },
    {
      kind: 'archiv',
      project: null,
      documents: [
        {
          documentId: 'doc-b',
          filename: 'Musterdetail.pdf',
          displayName: null,
          contentType: 'application/pdf',
          stand: { kind: 'date', text: '01.02.2025' },
          passages: [{ page: null, snippet: 'Treppe außen', score: 0.8 }],
        },
      ],
    },
    {
      kind: 'project',
      project: { id: 'p-2', name: 'Schule Baden', status: 'closed' },
      documents: [
        {
          documentId: 'doc-c',
          filename: 'Protokoll_v1.pdf',
          displayName: null,
          contentType: 'application/pdf',
          stand: null,
          passages: [{ page: 2, snippet: 'Außentreppe gefordert', score: 0.78 }],
        },
      ],
    },
  ],
}

const answering =
  (response: SimilarPassagesResponse): SimilarPassagesLoader =>
  async () =>
    response

const renderPanel = (load: SimilarPassagesLoader, props: Partial<Parameters<typeof SimilarPassagesPanel>[0]> = {}) => {
  const onOpen = vi.fn()
  const onClose = vi.fn()
  const onBackToSource = vi.fn()
  render(
    <SimilarPassagesPanel
      request={REQUEST}
      opened={null}
      onOpen={onOpen}
      onClose={onClose}
      onBackToSource={onBackToSource}
      load={load}
      {...props}
    />
  )
  return { onOpen, onClose, onBackToSource }
}

beforeEach(() => vi.clearAllMocks())

describe('SimilarPassagesPanel', () => {
  it('says it is searching, then answers in one line and lists the places, the Büroablage last', async () => {
    let resolve: (response: SimilarPassagesResponse) => void = () => {}
    renderPanel(() => new Promise((done) => (resolve = done)))

    expect(screen.getByText('Piloti is checking your projects…')).toBeTruthy()
    resolve(RESPONSE)

    expect(await screen.findByTestId('similar-headline')).toHaveTextContent('Found in 2 projects and the Büroablage')
    const groups = await screen.findAllByRole('heading', { level: 3 })
    // The server ranks the Büroablage second; the reader asks about projects first.
    expect(groups.map((heading) => heading.textContent)).toEqual([
      expect.stringContaining('Wohnhaus Mödling'),
      expect.stringContaining('Schule Baden'),
      'Büroablage',
    ])
    expect(within(groups[0]!).getByText('This project')).toBeTruthy()
    expect(within(groups[1]!).getByText('closed')).toBeTruthy()
    expect(screen.getAllByText('Brandschutzkonzept · Index C')).toHaveLength(2)
    expect(screen.getByText('Musterdetail.pdf · Dated 01.02.2025')).toBeTruthy()
    expect(screen.getByText('Protokoll_v1.pdf')).toBeTruthy()
    expect(screen.getByText('p. 3')).toBeTruthy()
    expect(screen.getByText('„Außentreppe in Stahlbeton“')).toBeTruthy()
    // The order is the relevance: no percentage reaches the reader.
    expect(screen.getByTestId('similar-passages').textContent).not.toMatch(/\d+\s?%/)
    expect(screen.getByRole('button', { name: 'Open Brandschutzkonzept, page 3' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Musterdetail.pdf' })).toBeTruthy()
    expect(capturePosthog).toHaveBeenCalledWith('similar_passages_searched', {
      entry: 'citation',
      origin: 'point',
      groups: 3,
      documents: 3,
      projects_searched: 3,
    })
  })

  it('says when only the Büroablage holds it', async () => {
    renderPanel(answering({ ...RESPONSE, groups: RESPONSE.groups.filter((group) => group.kind === 'archiv') }))
    expect(await screen.findByTestId('similar-headline')).toHaveTextContent('Found in the Büroablage')
  })

  it('hands the stage the passage to open: its document, page, words and where it is', async () => {
    const { onOpen } = renderPanel(answering(RESPONSE))
    fireEvent.click(await screen.findByRole('button', { name: 'Open Brandschutzkonzept, page 5' }))

    expect(onOpen).toHaveBeenCalledWith({
      key: 'doc-a#1',
      documentId: 'doc-a',
      filename: 'BSK.pdf',
      title: 'Brandschutzkonzept',
      contentType: 'application/pdf',
      page: 5,
      snippet: 'Laufbreite 1,20 m',
      groupKind: 'current',
      groupLabel: 'This project',
      rank: 0,
    })
  })

  it('marks the passage on the stage and offers the way back to the source', async () => {
    const { onBackToSource } = renderPanel(answering(RESPONSE), {
      opened: {
        key: 'doc-c#0',
        documentId: 'doc-c',
        filename: 'Protokoll_v1.pdf',
        title: 'Protokoll_v1.pdf',
        contentType: 'application/pdf',
        page: 2,
        snippet: 'Außentreppe gefordert',
        groupKind: 'project',
        groupLabel: 'Schule Baden',
        rank: 2,
      },
    })
    const current = await screen.findByRole('button', { name: 'Open Protokoll_v1.pdf, page 2' })
    expect(current.getAttribute('aria-current')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Back to the passage' }))
    expect(onBackToSource).toHaveBeenCalled()
  })

  it('walks the passages with the arrow keys', async () => {
    renderPanel(answering(RESPONSE))
    const first = await screen.findByRole('button', { name: 'Open Brandschutzkonzept, page 3' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open Brandschutzkonzept, page 5' }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open Protokoll_v1.pdf, page 2' }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open Brandschutzkonzept, page 5' }))
  })

  it('says what was searched when nothing came back', async () => {
    renderPanel(answering({ origin: 'embedded', projectsSearched: 2, groups: [] }))
    expect(await screen.findByText('Not handled in your office yet')).toBeTruthy()
    expect(screen.getByText('Checked this project, 2 other projects and the Büroablage.')).toBeTruthy()
    expect(screen.queryByTestId('similar-headline')).toBeNull()
  })

  it('offers a retry after a failed search, which asks again', async () => {
    const load = vi
      .fn<SimilarPassagesLoader>()
      .mockRejectedValueOnce(new SimilarPassagesError(503, 'failed'))
      .mockResolvedValueOnce(RESPONSE)
    renderPanel(load)

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: 'Open Brandschutzkonzept, page 3' })).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('says a held document is still being screened, with nothing to retry', async () => {
    renderPanel(async () => {
      throw new SimilarPassagesError(400, 'held')
    })
    expect(await screen.findByText('This document is still being screened')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('closes on its own button, and does not search again for the same passage on a re-render', async () => {
    const load = vi.fn(answering(RESPONSE))
    const { onClose } = renderPanel(load)
    await screen.findByRole('button', { name: 'Open Brandschutzkonzept, page 3' })
    fireEvent.click(screen.getByRole('button', { name: 'Close “Handled in your office”' }))
    expect(onClose).toHaveBeenCalled()
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
  })
})
