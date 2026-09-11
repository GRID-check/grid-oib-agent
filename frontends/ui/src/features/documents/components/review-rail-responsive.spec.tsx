/**
 * The review rail at phone width (ledger 40).
 *
 * The rail — „Freigabe und Fassungen" plus everything ingestion derived — is a
 * 280px column beside the document on a wide container and a stacked block
 * under it on a narrow one, and the whole flip is expressed in Tailwind
 * container-query classes. Nothing had ever opened it at 400px, for a reason
 * this file also fixes: the section renders only when the surface passes
 * `lifecyclePermissions`, and neither the dialog mount nor any preview did.
 *
 * jsdom has no layout engine and no container queries, so what is asserted here
 * is the CLASS SET — the same way `file-preview-pane.spec.tsx` asserts the
 * summary's `line-clamp-5`. That is a weaker claim than "it looks right", and
 * it is the half a unit test can hold: the rendered proof is
 * `visual/screenshots/file-preview-review.mobile.{light,dark}.png`, captured at
 * 390×844 from `/dev/file-preview?variant=review`. Each guards the other — the
 * classes catch a silent deletion, the shot catches a class set that is present
 * and wrong.
 */

import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { FilePreviewPane } from './file-preview-pane'
import { DocumentReviewControls } from './document-review-controls'
import type { DocumentVersionListResponse } from '@/lib/documents/lifecycle-types'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/app/projects/proj-1/files',
  useSearchParams: () => new URLSearchParams(),
}))

const file = {
  id: 'doc-1',
  filename: 'Brandschutzkonzept.pdf',
  displayName: null,
  fileSize: 1_048_576,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: ['Grundriss'],
}

const listing: DocumentVersionListResponse = {
  documentId: 'doc-1',
  lifecycle: 'active',
  publishedVersionId: null,
  versions: [
    {
      id: 'ver_1',
      documentId: 'doc-1',
      versionNumber: 1,
      state: 'in_review',
      contentType: 'text/markdown',
      fileSize: 18_400,
      contentHash: 'sha256:1',
      submittedBy: 'u-2',
      submittedAt: '2026-09-03T10:15:00.000Z',
      reviewedBy: null,
      reviewedAt: null,
      approvedBy: null,
      approvedAt: null,
      publishedBy: null,
      publishedAt: null,
      reviewComment: null,
      createdBy: 'u-2',
      createdAt: '2026-09-02T07:30:00.000Z',
      updatedAt: '2026-09-03T10:15:00.000Z',
    },
  ],
}

const renderPane = () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/versions/reviewers')) return Response.json({ candidates: [] })
      if (url.endsWith('/versions')) return Response.json(listing)
      return Response.json({})
    })
  )
  return render(
    <FilePreviewPane
      file={file}
      projectId="proj-1"
      projectName="Wohnbau Nord"
      canCollaborate
      lifecyclePermissions={['project:view', 'project:edit', 'project:documents:write']}
      viewerUserId="u-1"
    />
  )
}

describe('the review rail is a column on a wide container and a stacked block on a phone', () => {
  it('mounts at all when the surface passes lifecycle permissions', async () => {
    renderPane()
    // The whole of ADR-0054's reader-facing half hangs off this one condition.
    expect(await screen.findByTestId('document-lifecycle-panel')).toBeInTheDocument()
  })

  it('the rail is full width by default and only becomes a 280px column at @2xl', async () => {
    const { container } = renderPane()
    await screen.findByTestId('document-lifecycle-panel')

    const rail = container.querySelector('[data-testid="document-lifecycle-panel"]')
      ?.parentElement as HTMLElement
    expect(rail).toBeTruthy()
    const cls = rail.className
    // Stacked (the default, which is what a phone gets): full width, its own
    // top edge, and part of the body's single scroll.
    expect(cls).toContain('w-full')
    expect(cls).toContain('border-t')
    // Split (@2xl and up only): a fixed column with its own scroll and a LEFT
    // edge instead of a top one.
    expect(cls).toContain('@2xl:w-[280px]')
    expect(cls).toContain('@2xl:shrink-0')
    expect(cls).toContain('@2xl:overflow-y-auto')
    expect(cls).toContain('@2xl:border-l')
    expect(cls).toContain('@2xl:border-t-0')
    // The stacking is a container query, so the flip follows the PANE's width
    // rather than the viewport's — the pane is also 320px wide as a chat peek.
    expect(container.querySelector('.\\@container')).toBeTruthy()
  })

  it('the body stacks vertically and only becomes a row at @2xl', async () => {
    const { container } = renderPane()
    await screen.findByTestId('document-lifecycle-panel')

    const rail = container.querySelector('[data-testid="document-lifecycle-panel"]')
      ?.parentElement as HTMLElement
    const body = rail.parentElement as HTMLElement
    expect(body.className).toContain('flex-col')
    expect(body.className).toContain('@2xl:flex-row')
    // Stacked, ONE scroll for the whole body; split, one per column.
    expect(body.className).toContain('overflow-y-auto')
    expect(body.className).toContain('@2xl:overflow-hidden')
  })

  it('the type chip may shrink, so it cannot run under the header controls', async () => {
    const { container } = renderPane()
    await screen.findByTestId('document-lifecycle-panel')
    // Scoped to the HEADER: the same tag is also a chip down in the rail's tag
    // list, and only the header one is squeezed by the controls beside it.
    const nameColumn = container.querySelector('h3')?.parentElement as HTMLElement
    const badge = within(nameColumn).getByText('Grundriss').parentElement as HTMLElement
    // `Badge` is `w-fit shrink-0` by construction, so `min-w-0` alone never
    // made it narrow: at 390px „Grundriss" ran out of the name column and under
    // the Download button. Both halves of the fix are asserted, because either
    // one alone leaves the overlap.
    expect(badge.className).toContain('shrink')
    expect(badge.className).not.toContain('shrink-0')
    expect((badge.parentElement as HTMLElement).className).toContain('overflow-hidden')
    expect(container.querySelector('.truncate')).toBeTruthy()
  })
})

describe('the review controls wrap, and the comment box takes the whole width', () => {
  const version = listing.versions[0]!
  const viewer = {
    permissions: ['project:view', 'project:edit', 'project:documents:write'] as const,
    userId: 'u-1',
  }

  it('five decisions wrap into rows rather than a squeezed line', () => {
    const { container } = render(
      <DocumentReviewControls
        version={version}
        lifecycle="active"
        viewer={viewer}
        onAct={() => undefined}
      />
    )
    const row = container.querySelector('[data-testid="document-review-controls"] > div')
    expect(row?.className).toContain('flex-wrap')
    // All five, or the wrap is being asserted on a set that never needed it.
    expect(screen.getAllByRole('button')).toHaveLength(5)
  })

  it('the comment box is a full-width block under the controls, not beside them', async () => {
    render(
      <DocumentReviewControls
        version={version}
        lifecycle="active"
        viewer={viewer}
        onAct={() => undefined}
      />
    )
    screen.getByTestId('document-lifecycle-request_changes').click()
    const box = await waitFor(() => screen.getByTestId('document-review-comment'))
    // A sibling of the button row inside the same `space-y-2` column: the box
    // owns the width, so on a phone the reviewer types into a full-width field
    // rather than into whatever is left beside five buttons.
    expect(box.parentElement?.className).toContain('space-y-2')
    expect(box.className).not.toContain('absolute')
    expect(box.className).not.toContain('fixed')
    const textarea = screen.getByRole('textbox')
    expect(textarea.className).toContain('w-full')
  })
})
