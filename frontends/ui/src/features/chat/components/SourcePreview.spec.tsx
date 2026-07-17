import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'
import type { AnswerSourceRef } from '../lib/answer-sources'
import type { CitationSource } from '../types'
import {
  ReportSourcePreviewChip,
  SourcePreviewChip,
  resetSourcePreviewIndexCache,
} from './SourcePreview'

vi.mock('../store', () => ({
  useChatStore: (selector: (s: { projectId: string | null }) => unknown) =>
    selector({ projectId: 'project-1' }),
}))

const jsonResponse = (data: unknown) => ({ ok: true, json: async () => data })

/** Routes the module's three read APIs; anything else 404s. */
const fetchMock = vi.fn((input: RequestInfo | URL) => {
  const url = String(input)
  if (url.startsWith('/api/documents?projectId=')) {
    return Promise.resolve(
      jsonResponse({
        documents: [
          { id: 'doc-1', filename: 'Brandschutzkonzept.pdf', contentType: 'application/pdf' },
        ],
      })
    )
  }
  if (url === '/api/knowledge-base') {
    return Promise.resolve(
      jsonResponse({
        files: [{ fileName: 'oib-rl_2.pdf', state: 'ingested', origin: 'corpus' }],
      })
    )
  }
  if (url === '/api/documents/doc-1/preview') {
    return Promise.resolve(jsonResponse({ url: 'https://storage.example/presigned.pdf' }))
  }
  return Promise.resolve({ ok: false, json: async () => ({}) })
})

const citation = (overrides: Partial<CitationSource>): CitationSource => ({
  id: 'c-1',
  url: '',
  content: '',
  timestamp: new Date('2026-07-17T10:00:00Z'),
  ...overrides,
})

const sourceRef = (overrides: Partial<AnswerSourceRef>): AnswerSourceRef => ({
  key: 'k-1',
  label: 'label',
  kind: 'kb',
  ...overrides,
})

describe('SourcePreviewChip', () => {
  beforeEach(() => {
    resetSourcePreviewIndexCache()
    fetchMock.mockClear()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('web/RIS citations keep linking out and trigger no index fetch', () => {
    render(
      <SourcePreviewChip
        source={sourceRef({
          label: 'example.com',
          kind: 'web',
          url: 'https://example.com/article',
          citation: citation({ url: 'https://example.com/article' }),
        })}
        signal="auto"
      />
    )

    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', 'https://example.com/article')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('a KB citation resolving to a project document opens the document dialog', async () => {
    const user = userEvent.setup()
    render(
      <SourcePreviewChip
        source={sourceRef({
          label: 'Brandschutzkonzept.pdf',
          citation: citation({ content: '[KB] Brandschutzkonzept.pdf, p.3' }),
        })}
        signal="project"
      />
    )

    // The chip upgrades to a button once the resolution index has loaded.
    const chip = await screen.findByRole('button', {
      name: 'Preview source: Brandschutzkonzept.pdf',
    })
    await user.click(chip)

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Brandschutzkonzept.pdf')).toBeInTheDocument()
    expect(within(dialog).getByText('Project document')).toBeInTheDocument()
    // The presigned preview URL was fetched for the project document.
    expect(fetchMock).toHaveBeenCalledWith('/api/documents/doc-1/preview')
  })

  test('an unresolvable KB citation with a passage opens an info popover — no viewer', async () => {
    const user = userEvent.setup()
    render(
      <SourcePreviewChip
        source={sourceRef({
          label: 'unbekannt.pdf',
          citation: citation({ content: '[KB] unbekannt.pdf\nZitierter Absatz.' }),
        })}
        signal="project"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Preview source: unbekannt.pdf' }))

    expect(await screen.findByText('Cited passage')).toBeInTheDocument()
    expect(screen.getByText('Zitierter Absatz.')).toBeInTheDocument()
    // No document viewer opened (the popover itself carries role="dialog",
    // so assert on the viewer's frame instead).
    expect(document.querySelector('iframe')).toBeNull()
  })

  test('card-derived refs without a snippet stay plain, non-interactive chips', () => {
    render(
      <SourcePreviewChip source={sourceRef({ label: 'OIB-Richtlinie 2', kind: 'ris' })} signal="law" />
    )

    expect(screen.getByText('OIB-Richtlinie 2')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('ReportSourcePreviewChip', () => {
  beforeEach(() => {
    resetSourcePreviewIndexCache()
    fetchMock.mockClear()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('renders a View affordance for a resolvable base-corpus entry', async () => {
    render(<ReportSourcePreviewChip locatorText="oib-rl_2.pdf, p.12" />)

    expect(
      await screen.findByRole('button', { name: 'Preview source: oib-rl_2.pdf' })
    ).toHaveTextContent('View')
  })

  test('renders nothing for an unresolvable entry', async () => {
    const { container } = render(<ReportSourcePreviewChip locatorText="nicht-vorhanden.pdf" />)

    // Give the index a tick to load; the chip must still render nothing.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.querySelector('button')).toBeNull()
  })
})
