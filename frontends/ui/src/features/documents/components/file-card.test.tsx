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
import { ThumbnailWithFallback, resetThumbnailCache } from './file-card'
import type { FileItem } from './project-file-workspace'

function file(id: string, filename: string, contentType: string | null): FileItem {
  return {
    id,
    filename,
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
