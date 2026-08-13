/**
 * Tests for ThumbnailWithFallback — the file-card thumbnail loader. Focus: the
 * three honest states the P1 audit demanded are distinct — a skeleton while the
 * request is in flight, a WARM placeholder (with a format chip) when no
 * thumbnail exists, and a distinct "couldn't load" treatment ONLY on a genuine
 * failure — plus the module-level de-dup cache (one fetch per file id).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@/test-utils'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import { FileCard, ThumbnailWithFallback, resetThumbnailCache } from './file-card'
import type { FileItem } from './project-file-workspace'

function file(id: string, filename: string, contentType: string | null): FileItem {
  return {
    id,
    filename,
    displayName: null,
    fileSize: 1024,
    contentType,
    status: 'ready',
    folderId: null,
    createdAt: '2026-01-01T00:00:00Z',
    errorMessage: null,
    summary: null,
    pageCount: null,
    chunkCount: null,
    contentTypes: null,
    tags: null,
  }
}

afterEach(() => resetThumbnailCache())

describe('ThumbnailWithFallback', () => {
  it('shows a skeleton while the thumbnail request is in flight, then the image', async () => {
    server.use(
      http.get('/api/documents/:id/thumbnail', () => HttpResponse.json({ url: 'https://cdn.test/t.png' }))
    )

    const { container } = render(<ThumbnailWithFallback file={file('i1', 'Foto.png', 'image/png')} />)

    // In-flight: a skeleton, never a jump straight to the fallback glyph.
    expect(screen.getByTestId('thumbnail-skeleton')).toBeInTheDocument()

    await waitFor(() => expect(container.querySelector('img')).toBeInTheDocument())
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://cdn.test/t.png')
  })

  it('falls back to a WARM image placeholder with a format chip when no thumbnail exists', async () => {
    // 200 with a null url = "no thumbnail available" — NOT a failure.
    server.use(http.get('/api/documents/:id/thumbnail', () => HttpResponse.json({ url: null })))

    render(<ThumbnailWithFallback file={file('i2', 'Fassade.png', 'image/png')} />)

    await waitFor(() => {
      const tile = screen.getByTestId('document-kind-thumbnail')
      expect(tile).toHaveAttribute('data-state', 'placeholder')
      expect(tile).toHaveAttribute('data-kind', 'photo')
    })
    // The format chip carries an icon + label (never a lone glyph).
    expect(screen.getByText('PNG')).toBeInTheDocument()
  })

  it('treats a 404 as "no thumbnail" (warm placeholder), not a failure', async () => {
    server.use(http.get('/api/documents/:id/thumbnail', () => HttpResponse.json({}, { status: 404 })))

    render(<ThumbnailWithFallback file={file('i3', 'Bild.jpg', 'image/jpeg')} />)

    await waitFor(() =>
      expect(screen.getByTestId('document-kind-thumbnail')).toHaveAttribute('data-state', 'placeholder')
    )
  })

  it('shows the distinct "couldn\'t load" treatment ONLY on a genuine failure (5xx)', async () => {
    server.use(http.get('/api/documents/:id/thumbnail', () => HttpResponse.json({}, { status: 500 })))

    render(<ThumbnailWithFallback file={file('i4', 'Plan.png', 'image/png')} />)

    await waitFor(() =>
      expect(screen.getByTestId('document-kind-thumbnail')).toHaveAttribute('data-state', 'failed')
    )
    expect(screen.getByText('Preview unavailable')).toBeInTheDocument()
  })

  it('de-dups the thumbnail fetch per file id via the module cache', async () => {
    const hits = vi.fn()
    server.use(
      http.get('/api/documents/:id/thumbnail', () => {
        hits()
        return HttpResponse.json({ url: null })
      })
    )

    const f = file('i5', 'Foto.png', 'image/png')
    render(
      <>
        <ThumbnailWithFallback file={f} />
        <ThumbnailWithFallback file={f} />
      </>
    )

    await waitFor(() => expect(screen.getAllByTestId('document-kind-thumbnail')).toHaveLength(2))
    // Two cards for the same id → a single network fetch.
    expect(hits).toHaveBeenCalledTimes(1)
  })

  it('re-asks after ingestion finishes when the document had no preview yet', async () => {
    // A document uploaded a moment ago: the page renders while the backend is
    // still reading it, so the first ask legitimately finds no thumbnail. The
    // second ask — the one the status transition triggers — finds it.
    let hits = 0
    server.use(
      http.get('/api/documents/:id/thumbnail', () => {
        hits += 1
        return HttpResponse.json({ url: hits === 1 ? null : '/api/documents/i6/image?sig=abc' })
      })
    )

    const uploading = { ...file('i6', 'Schnitt.pdf', 'application/pdf'), status: 'processing' }
    const { rerender, container } = render(<ThumbnailWithFallback file={uploading} />)

    await waitFor(() =>
      expect(screen.getByTestId('document-kind-thumbnail')).toHaveAttribute('data-state', 'placeholder')
    )

    // Ingestion finished — the card must not stay on the placeholder until a reload.
    rerender(<ThumbnailWithFallback file={{ ...uploading, status: 'ready' }} />)

    await waitFor(() => expect(container.querySelector('img')).toBeInTheDocument())
    expect(hits).toBe(2)
  })

  it('does not re-ask a settled document that genuinely has no thumbnail', async () => {
    // The counterpart to the case above: for a terminal status "no thumbnail"
    // is the final word, so the cached miss must still suppress the refetch.
    let hits = 0
    server.use(
      http.get('/api/documents/:id/thumbnail', () => {
        hits += 1
        return HttpResponse.json({ url: null })
      })
    )

    const settled = file('i7', 'Foto.png', 'image/png')
    const { rerender } = render(<ThumbnailWithFallback file={settled} />)

    await waitFor(() =>
      expect(screen.getByTestId('document-kind-thumbnail')).toHaveAttribute('data-state', 'placeholder')
    )

    rerender(<ThumbnailWithFallback file={{ ...settled }} />)
    await waitFor(() => expect(hits).toBe(1))
  })

  it('does not fetch for a type that cannot have a thumbnail — warm sketch immediately', async () => {
    const hits = vi.fn()
    server.use(
      http.get('/api/documents/:id/thumbnail', () => {
        hits()
        return HttpResponse.json({ url: null })
      })
    )

    render(<ThumbnailWithFallback file={file('d1', 'Zeichnung.dwg', 'application/acad')} />)

    // Non-thumbnailable → the content sketch, no skeleton, no fetch.
    expect(screen.getByTestId('document-kind-thumbnail')).toHaveAttribute('data-state', 'placeholder')
    expect(screen.queryByTestId('thumbnail-skeleton')).not.toBeInTheDocument()
    expect(hits).not.toHaveBeenCalled()
  })
})

/**
 * The tile has to reach the bottom of its grid cell whatever it carries. A
 * document that is still being read has no AI summary yet, so it is shorter than
 * its settled neighbours; the grid stretches every cell to the row height, and
 * the card used to keep its natural height inside that cell — the size · time
 * footer floated in the middle of the tile with a band of dead surface beneath.
 *
 * jsdom does no layout, so what is asserted is the mechanism rather than the
 * pixels: the raised content block is the growing flex child. The rendered
 * result is pinned by the `file-browser-uploading` screenshot target.
 */
describe('FileCard while the document is still being read', () => {
  const unsettled: FileItem = { ...file('c1', 'Schnitt.pdf', 'application/pdf'), status: 'processing' }

  it('grows the raised content block so the footer sits on the bottom edge', () => {
    render(<FileCard file={unsettled} isSelected={false} onSelect={() => {}} locale="de" />)

    const card = screen.getByTestId('file-card')
    expect(card.className).toContain('h-full')
    expect(card.className).toContain('flex-col')

    // First child is the raised white block, last is the size · time footer tab.
    const [contentBlock] = Array.from(card.children)
    expect(contentBlock.className).toContain('flex-1')
    expect(card.lastElementChild).not.toBe(contentBlock)
  })

  it('holds the description slot with skeleton lines instead of leaving it blank', () => {
    render(<FileCard file={unsettled} isSelected={false} onSelect={() => {}} locale="de" />)

    // Decorative — the status badge already says "Processing" in words.
    const placeholder = screen.getByTestId('file-card-summary-skeleton')
    expect(placeholder).toHaveAttribute('aria-hidden')
  })

  it('drops the skeleton the moment the real summary arrives', () => {
    const summarized: FileItem = { ...unsettled, status: 'ready', summary: 'Perspektivischer Schnitt, Bauteil A.' }

    render(<FileCard file={summarized} isSelected={false} onSelect={() => {}} locale="de" />)

    expect(screen.queryByTestId('file-card-summary-skeleton')).not.toBeInTheDocument()
    expect(screen.getByText('Perspektivischer Schnitt, Bauteil A.')).toBeInTheDocument()
  })

  it('shows the failure reason rather than a skeleton when ingestion failed', () => {
    const failed: FileItem = { ...unsettled, status: 'failed', errorMessage: 'Verschlüsseltes PDF' }

    render(<FileCard file={failed} isSelected={false} onSelect={() => {}} locale="de" />)

    expect(screen.queryByTestId('file-card-summary-skeleton')).not.toBeInTheDocument()
    expect(screen.getByText('Verschlüsseltes PDF')).toBeInTheDocument()
  })

  it('omits the size · time strip when hideFooter is set', () => {
    render(
      <FileCard
        file={file('c2', 'Schnitt.pdf', 'application/pdf')}
        isSelected={false}
        onSelect={() => {}}
        locale="en"
        hideFooter
      />,
    )

    const card = screen.getByTestId('file-card')
    expect(card.lastElementChild?.className).toContain('flex-1')
    expect(screen.queryByText(/KB|MB/)).not.toBeInTheDocument()
  })

  it('shows the rename, and still reads the format from the file itself', () => {
    render(
      <FileCard
        file={{ ...file('doc-1', 'plan.pdf', 'application/pdf'), displayName: 'Einreichplan EG.pdf' }}
        isSelected={false}
        onSelect={vi.fn()}
        locale="de"
      />
    )

    expect(screen.getByText('Einreichplan EG.pdf')).toBeInTheDocument()
    expect(screen.queryByText('plan.pdf')).not.toBeInTheDocument()
    // The chip is a claim about the bytes, not about the label.
    expect(screen.getByText('PDF')).toBeInTheDocument()
  })
})
