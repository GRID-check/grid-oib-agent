/**
 * Source chips pay for their popover only once a reader engages one.
 *
 * The Radix Popover mounts per chip only once a reader engages it: an answer's
 * "Belegt durch" row and a Herleitung full of source cards would otherwise mount
 * one per chip up front. These cases pin the lazy mount per
 * chip KIND (info, document, card) and, above all, that engagement does not
 * remount the button: the focus stays and the tap still clicks.
 */

import { render, screen, waitFor, within, fireEvent } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'
import { buildCitationModel, type CitationRef, type CitedDocument } from '../lib/citations'
import type { CitationSource } from '../types'
import { popoverMounts, resetPopoverMounts } from '@/test-utils/popover-mounts'
import { SourcePreviewChip, resetSourcePreviewIndexCache } from './SourcePreview'
import { SourceCard } from './reasoning/SourceCard'

vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/test-utils/popover-mounts')).countPopoverMounts(await importOriginal())
)

vi.mock('../store', () => ({
  useChatStore: (
    selector: (s: {
      projectId: string | null
      currentConversation: { id: string } | null
    }) => unknown
  ) => selector({ projectId: 'project-1', currentConversation: { id: 'conv-1' } }),
}))

const jsonResponse = (data: unknown) => ({ ok: true, json: async () => data })

const fetchMock = vi.fn((input: RequestInfo | URL) => {
  const url = String(input)
  // The cited document, resolved by name.
  if (url === '/api/documents/by-name') {
    return Promise.resolve(
      jsonResponse({
        documents: [
          {
            id: 'doc-1',
            filename: 'Brandschutzkonzept.pdf',
            contentType: 'application/pdf',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
    )
  }
  if (url === '/api/documents/doc-1/preview') {
    return Promise.resolve(jsonResponse({ url: 'https://storage.example/presigned.pdf' }))
  }
  return Promise.resolve(jsonResponse({ documents: [], files: [] }))
})

const citation = (overrides: Partial<CitationSource>): CitationSource => ({
  id: 'c-1',
  url: '',
  content: '',
  timestamp: new Date('2026-07-17T10:00:00Z'),
  ...overrides,
})

const documentOf = (overrides: Partial<CitationSource>): CitedDocument => {
  const [document] = buildCitationModel({ citations: [citation(overrides)] })
  if (!document) throw new Error('fixture produced no document')
  return document
}

const ref = (overrides: Partial<CitationSource>): CitationRef => {
  const document = documentOf(overrides)
  return { document, locus: document.loci[0] }
}

/** A legal web source with a tier: the info chip, no fetch involved. */
const lawRef = (n: number): CitationRef =>
  ref({
    id: `law-${n}`,
    title: `Gesetz ${n}`,
    kind: 'web',
    origin: 'web',
    url: `https://example.com/law-${n}`,
    laneLabel: 'Fachliteratur',
  })

const projectDocument = {
  content: '[KB] Brandschutzkonzept.pdf, p.3',
  citationKey: 'Brandschutzkonzept.pdf, p.3',
  fileName: 'Brandschutzkonzept.pdf',
  collection: 'proj_1',
  kind: 'projekt',
  page: 3,
  number: 1,
  isCited: true,
} satisfies Partial<CitationSource>

describe('source chips mount their peek lazily', () => {
  beforeEach(() => {
    resetSourcePreviewIndexCache()
    resetPopoverMounts()
    fetchMock.mockClear()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('a row of chips renders no popover until one is engaged', async () => {
    const user = userEvent.setup()
    render(
      <div>
        {Array.from({ length: 8 }, (_, i) => (
          <SourcePreviewChip key={i} citation={lawRef(i)} />
        ))}
        <SourcePreviewChip citation={ref(projectDocument)} />
      </div>
    )
    await screen.findByRole('button', { name: 'Preview source: Brandschutzkonzept' })

    expect(popoverMounts.total).toBe(0)
    const third = screen.getByRole('button', { name: 'Preview source: Gesetz 2' })
    expect(third).toHaveAttribute('aria-haspopup', 'dialog')
    expect(third).toHaveAttribute('aria-expanded', 'false')

    await user.hover(third)
    expect(popoverMounts.current).toBe(1)
    expect(await screen.findByText('Fachliteratur')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preview source: Gesetz 2' })).toBe(third)
    expect(third).toHaveAttribute('aria-expanded', 'true')
  })

  test('keyboard focus opens the info peek and keeps focus on the same chip', async () => {
    const user = userEvent.setup()
    render(<SourcePreviewChip citation={lawRef(1)} />)
    const chip = screen.getByRole('button', { name: 'Preview source: Gesetz 1' })

    await user.tab()
    expect(document.activeElement).toBe(chip)
    expect(await screen.findByText('Fachliteratur')).toBeInTheDocument()
    expect(chip.isConnected).toBe(true)
    expect(document.activeElement).toBe(chip)

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByText('Fachliteratur')).toBeNull())
    expect(chip).toHaveAttribute('aria-expanded', 'false')
  })

  test('a touch tap on an info chip pins its peek; an outside tap closes it', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <SourcePreviewChip citation={lawRef(1)} />
        <button type="button">Elsewhere</button>
      </div>
    )
    const chip = screen.getByRole('button', { name: 'Preview source: Gesetz 1' })

    await user.pointer([{ keys: '[TouchA]', target: chip }])
    expect(await screen.findByText('Fachliteratur')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preview source: Gesetz 1' })).toBe(chip)

    await user.pointer([{ keys: '[TouchA]', target: screen.getByText('Elsewhere') }])
    await waitFor(() => expect(screen.queryByText('Fachliteratur')).toBeNull())
  })

  test('a document chip: hover peeks, a tap opens the document on the first try', async () => {
    const user = userEvent.setup()
    render(<SourcePreviewChip citation={ref(projectDocument)} />)
    const chip = await screen.findByRole('button', {
      name: 'Preview source: Brandschutzkonzept',
    })
    expect(popoverMounts.total).toBe(0)

    await user.hover(chip)
    expect(await screen.findByText('Open at this passage')).toBeInTheDocument()
    await user.unhover(chip)
    await waitFor(() => expect(screen.queryByText('Open at this passage')).toBeNull())

    await user.pointer([{ keys: '[TouchA]', target: chip }])
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Project document')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/documents/doc-1/preview')
  })

  test('a tap that engages a never-touched document chip still opens it', async () => {
    render(<SourcePreviewChip citation={ref(projectDocument)} />)
    const chip = await screen.findByRole('button', {
      name: 'Preview source: Brandschutzkonzept',
    })

    // Engagement lands between the finger and the click — the window in which
    // a remounted button would swallow the tap.
    fireEvent.pointerDown(chip, { pointerType: 'touch' })
    expect(popoverMounts.current).toBe(1)
    expect(chip.isConnected).toBe(true)
    fireEvent.click(chip)

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  test('a Herleitung source card mounts nothing until tapped, then opens its document', async () => {
    const user = userEvent.setup()
    const document = documentOf(projectDocument)
    render(
      <div role="list">
        <SourceCard document={document} hitLabel="1 Treffer" gapLabel="0 Treffer" />
        <SourceCard
          document={documentOf({ ...projectDocument, id: 'c-2' })}
          hitLabel="1 Treffer"
          gapLabel="0 Treffer"
        />
      </div>
    )
    const [card] = await screen.findAllByRole('button', {
      name: 'Preview source: Brandschutzkonzept',
    })
    expect(popoverMounts.total).toBe(0)

    await user.pointer([{ keys: '[TouchA]', target: card! }])
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(popoverMounts.total).toBe(1)
  })
})
