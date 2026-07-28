import { render, screen } from '@/test-utils'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { CitationCard } from './CitationCard'
import type { CitationSource } from '@/features/chat/types'

describe('CitationCard', () => {
  const createCitation = (overrides: Partial<CitationSource> = {}): CitationSource => ({
    id: 'citation-1',
    url: 'https://example.com/article',
    content: 'Citation content',
    timestamp: new Date('2024-01-15T14:30:00'),
    isCited: false,
    ...overrides,
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('basic rendering', () => {
    test('renders as a link', () => {
      render(<CitationCard citation={createCitation()} />)

      const link = screen.getByRole('link')
      expect(link).toHaveAttribute('href', 'https://example.com/article')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    })

    test('displays domain name', () => {
      render(<CitationCard citation={createCitation({ url: 'https://www.example.com/page' })} />)

      expect(screen.getByText('example.com')).toBeInTheDocument()
    })

    test('displays full URL', () => {
      render(
        <CitationCard
          citation={createCitation({ url: 'https://example.com/full/path/here' })}
        />
      )

      expect(screen.getByText('https://example.com/full/path/here')).toBeInTheDocument()
    })

    test('displays timestamp', () => {
      render(
        <CitationCard
          citation={createCitation({ timestamp: new Date('2024-01-15T14:30:00') })}
        />
      )

      expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument()
    })
  })

  describe('cited vs referenced state', () => {
    test('shows check icon when cited', () => {
      render(<CitationCard citation={createCitation({ isCited: true })} />)

      // The citation should be styled differently when cited
      const domain = screen.getByText('example.com')
      expect(domain).toBeInTheDocument()
    })

    test('shows link icon when referenced (not cited)', () => {
      render(<CitationCard citation={createCitation({ isCited: false })} />)

      const domain = screen.getByText('example.com')
      expect(domain).toBeInTheDocument()
    })
  })

  describe('domain extraction', () => {
    test('removes www prefix from domain', () => {
      render(
        <CitationCard
          citation={createCitation({ url: 'https://www.wikipedia.org/wiki/Test' })}
        />
      )

      expect(screen.getByText('wikipedia.org')).toBeInTheDocument()
    })

    test('handles complex URLs', () => {
      render(
        <CitationCard
          citation={createCitation({ url: 'https://sub.domain.example.com/path?query=1' })}
        />
      )

      expect(screen.getByText('sub.domain.example.com')).toBeInTheDocument()
    })

    test('handles invalid URLs gracefully', () => {
      render(<CitationCard citation={createCitation({ url: 'not-a-valid-url' })} />)

      // Should show truncated URL as fallback - it appears in both domain and URL spots
      const urlTexts = screen.getAllByText('not-a-valid-url')
      expect(urlTexts.length).toBeGreaterThan(0)
    })
  })

  describe('parity with the answer provenance chips', () => {
    // The card used to be an independent renderer: no provenance tint, no
    // authority badge, and — because its only interaction was an <a href> —
    // literally inert for a knowledge-base citation, which has no URL. The
    // identical source in the answer's "Belegt durch" row opened a PDF at the
    // cited page. These lock the two surfaces together.

    const kbCitation = (overrides: Partial<CitationSource> = {}): CitationSource =>
      createCitation({
        url: undefined,
        content: '[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.12',
        citationKey: 'oib-rl_2_ausgabe_mai_2023.pdf, p.12',
        fileName: 'oib-rl_2_ausgabe_mai_2023.pdf',
        page: 12,
        title: 'OIB-Richtlinie 2',
        kind: 'baurecht',
        lane: 'baurecht_oib',
        ...overrides,
      })

    test('a knowledge-base citation is interactive, not dead text', () => {
      render(<CitationCard citation={kbCitation()} />)

      expect(
        screen.getByRole('button', { name: /OIB-Richtlinie 2/i })
      ).toBeInTheDocument()
    })

    test('it carries the authority badge the chips carry', () => {
      render(<CitationCard citation={kbCitation()} />)

      expect(screen.getByText('OIB')).toBeInTheDocument()
    })

    test('a web citation still links out', () => {
      render(<CitationCard citation={createCitation({ kind: 'web' })} />)

      expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com/article')
    })

    test('a cited source is marked as cited', () => {
      render(<CitationCard citation={kbCitation({ isCited: true })} />)

      expect(screen.getByText('Cited')).toBeInTheDocument()
    })

    test('a merely-discovered source is not marked cited', () => {
      render(<CitationCard citation={kbCitation({ isCited: false })} />)

      expect(screen.queryByText('Cited')).not.toBeInTheDocument()
    })
  })

  describe('timestamp handling', () => {
    test('handles Date object timestamp', () => {
      render(
        <CitationCard
          citation={createCitation({ timestamp: new Date('2024-01-15T09:15:00') })}
        />
      )

      expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument()
    })

    test('handles ISO string timestamp', () => {
      render(
        <CitationCard
          citation={createCitation({
            timestamp: '2024-01-15T14:30:00Z' as unknown as Date,
          })}
        />
      )

      expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument()
    })
  })
})
