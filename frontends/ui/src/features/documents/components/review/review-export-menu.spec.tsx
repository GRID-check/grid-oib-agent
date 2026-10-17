/**
 * „Protokoll exportieren" in the Prüfansicht: the choices reach the link, the
 * Fassung and proposal choices appear only where they mean something, the
 * file is saved under the server's name, and a refusal is a toast.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/browser-download', () => ({ startBrowserDownload: vi.fn() }))

import { toast } from 'sonner'
import { render, screen } from '@/test-utils'
import { startBrowserDownload } from '@/lib/browser-download'
import { ReviewExportMenu } from './review-export-menu'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  // jsdom has no object URLs; this file's own environment, so nothing else sees them.
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:protokoll'), revokeObjectURL: vi.fn() })
  fetchMock.mockResolvedValue(
    new Response(new Blob(['%PDF']), {
      status: 200,
      headers: {
        'Content-Disposition': `attachment; filename="x.pdf"; filename*=UTF-8''${encodeURIComponent('Anmerkungen – Grundriss EG – Fassung 3.pdf')}`,
      },
    })
  )
})

afterEach(() => vi.unstubAllGlobals())

const open = async (props: Partial<Parameters<typeof ReviewExportMenu>[0]> = {}) => {
  const user = userEvent.setup()
  render(<ReviewExportMenu documentId="doc_1" hasFassungen={false} hasProposals={false} {...props} />)
  await user.click(screen.getByRole('button', { name: 'Export minutes' }))
  return user
}

describe('ReviewExportMenu', () => {
  it('downloads the open marks of the current Fassung by default, under the name the server gave', async () => {
    const user = await open()
    await user.click(await screen.findByRole('menuitem', { name: 'PDF' }))

    expect(fetchMock).toHaveBeenCalledWith('/api/documents/doc_1/annotations/export?format=pdf&scope=open&fassung=current')
    await vi.waitFor(() =>
      expect(startBrowserDownload).toHaveBeenCalledWith('blob:protokoll', 'Anmerkungen – Grundriss EG – Fassung 3.pdf')
    )
  })

  it('carries the scope, the Fassung and the proposals into the link, and stays open while choosing', async () => {
    const user = await open({ hasFassungen: true, hasProposals: true })
    await user.click(await screen.findByRole('menuitemradio', { name: 'Resolved ones too' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'All revisions' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Add Piloti’s proposals' }))
    await user.click(screen.getByRole('menuitem', { name: 'Word (.docx)' }))

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/documents/doc_1/annotations/export?format=docx&scope=all&fassung=all&includeProposals=1'
    )
  })

  it('offers no Fassung or proposal choice where the document has neither', async () => {
    await open()
    expect(await screen.findByRole('menuitemradio', { name: 'Open only' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio', { name: 'All revisions' })).toBeNull()
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Add Piloti’s proposals' })).toBeNull()
  })

  it('says why a PDF was refused, and points at Word and Markdown', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 422 }))
    const user = await open()
    await user.click(await screen.findByRole('menuitem', { name: 'PDF' }))

    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('Too long for a PDF. Export them as Word or Markdown.'))
    expect(startBrowserDownload).not.toHaveBeenCalled()
  })
})
