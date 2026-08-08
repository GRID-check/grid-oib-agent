import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { CopyCitationsMenu, CopySourceCitationButton } from './CopyCitation'
import { buildCitationModel, type CitationRef } from '../lib/citations'

vi.mock('../store', () => ({
  useChatStore: vi.fn((selector?: (s: unknown) => unknown) => {
    const state = { projectId: null }
    return selector ? selector(state) : state
  }),
}))

const [document] = buildCitationModel({
  citations: [
    {
      id: 'c1',
      content: '',
      timestamp: new Date('2026-07-28T12:00:00Z'),
      title: 'OIB-Richtlinie 2 – Brandschutz, Ausgabe Mai 2023',
      fileName: 'oib-rl_2_ausgabe_mai_2023.pdf',
      citationKey: 'oib-rl_2_ausgabe_mai_2023.pdf, p.18',
      collection: 'oib_knowledge',
      kind: 'baurecht',
      lane: 'baurecht_oib',
      origin: 'kb',
      page: 18,
      number: 1,
      isCited: true,
    },
  ],
})
const citation: CitationRef = { document: document!, locus: document!.loci[0] }

describe('citation copy', () => {
  let writeText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined)
  })

  const installClipboard = () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })
  }

  test('the per-source button copies a usable Fachtext citation, not a URL', async () => {
    const user = userEvent.setup()
    render(<CopySourceCitationButton citation={citation} />)
    installClipboard()

    await user.click(screen.getByRole('button', { name: /copy citation for/i }))

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const copied = writeText.mock.calls[0][0] as string
    expect(copied).toContain('OIB-Richtlinie 2 – Brandschutz')
    expect(copied).toContain('S. 18')
    expect(copied).toContain('Österreichisches Institut für Bautechnik')
  })

  test('the block menu offers the interchange formats external tools read', async () => {
    const user = userEvent.setup()
    render(<CopyCitationsMenu citations={[citation]} />)

    await user.click(screen.getByRole('button', { name: /cite/i }))

    expect(await screen.findByText('BibTeX (.bib)')).toBeInTheDocument()
    expect(screen.getByText('EndNote/Zotero (.ris)')).toBeInTheDocument()
    expect(screen.getByText('CSL-JSON')).toBeInTheDocument()
  })

  test('picking BibTeX copies what the BFF rendered', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: '@standard{oib, …}' }) })
    )
    render(<CopyCitationsMenu citations={[citation]} />)
    installClipboard()

    await user.click(screen.getByRole('button', { name: /cite/i }))
    await user.click(await screen.findByText('BibTeX (.bib)'))

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText.mock.calls[0][0]).toBe('@standard{oib, …}')
    vi.unstubAllGlobals()
  })
})
