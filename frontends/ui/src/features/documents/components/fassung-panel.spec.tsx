/**
 * The Fassung panel as a reader meets it: where a document stands among its
 * revisions, and Piloti's suggestion that it replaces another.
 *
 * The rules that decide WHICH links exist are specced in
 * `src/lib/documents/fassung.spec.ts` and `fassung-facts.spec.ts`. Here the
 * request is mocked: what is asserted is what the panel says for each state,
 * what it sends when a person decides, and what it does when that fails.
 *
 * The copy is German, the way a planning office reads it (`fassung-panel.tsx`
 * is mounted under `I18nProvider` with `fixedLocale`, as the sibling specs do).
 */

import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { I18nProvider } from '@/i18n'
import { EMPTY_FASSUNG, type FassungFacts, type FassungRef } from '@/lib/documents/fassung'
import type { FileItem } from '../file-types'
import { setFassungLink } from '../lib/fassung-request'
import { FassungPanel, changeLines } from './fassung-panel'

vi.mock('../lib/fassung-request', () => ({
  setFassungLink: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

const fileFixture = (overrides: Partial<FileItem> = {}): FileItem => ({
  id: 'doc-1',
  filename: 'Grundriss_C.pdf',
  displayName: null,
  fileSize: 1024,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-08-14T00:00:00.000Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
  topics: null,
  capture: null,
  ...overrides,
})

const facts = (overrides: Partial<FassungFacts> = {}): FassungFacts => ({ ...EMPTY_FASSUNG, ...overrides })

const ref = (id: string, filename: string): FassungRef => ({ id, filename })

/** The panel under the German dictionary, rendered the way sibling specs render a locale. */
const panel = (props: { file: FileItem; canManage: boolean; onFassungChanged?: (id: string, f: FassungFacts) => void }) => (
  <I18nProvider initialLocale="de" fixedLocale>
    <FassungPanel {...props} />
  </I18nProvider>
)

const renderPanel = (ui: ReactElement) => render(ui)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('FassungPanel', () => {
  describe('when there is nothing to say', () => {
    it('renders nothing when the file carries no Fassung facts', () => {
      const { container } = renderPanel(panel({ file: fileFixture(), canManage: true }))

      expect(container).toBeEmptyDOMElement()
    })

    it('renders nothing when the facts are the empty ones, as after an unlink', () => {
      const { container } = renderPanel(
        panel({ file: fileFixture({ fassung: EMPTY_FASSUNG }), canManage: true }),
      )

      expect(container).toBeEmptyDOMElement()
    })
  })

  describe('a superseded document', () => {
    it('names the newer file that replaces it', () => {
      renderPanel(
        panel({
          file: fileFixture({
            fassung: facts({ supersededBy: ref('doc-2', 'Grundriss_D.pdf') }),
          }),
          canManage: true,
        }),
      )

      const superseded = screen.getByTestId('fassung-superseded')
      expect(superseded).toHaveTextContent('Ältere Fassung. Ersetzt durch Grundriss_D.pdf.')
      expect(superseded).toHaveTextContent('Piloti antwortet aus der neueren Fassung.')
    })

    it('does not offer to unlink the newer file, which is the other document’s decision', () => {
      renderPanel(
        panel({
          file: fileFixture({ fassung: facts({ supersededBy: ref('doc-2', 'Grundriss_D.pdf') }) }),
          canManage: true,
        }),
      )

      expect(screen.queryByRole('button', { name: 'Verknüpfung lösen' })).toBeNull()
    })
  })

  describe('a document that replaces older ones', () => {
    it('lists the names of the older Fassungen it replaces', () => {
      renderPanel(
        panel({
          file: fileFixture({
            fassung: facts({ supersedes: [ref('doc-0', 'Grundriss_A.pdf'), ref('doc-0b', 'Grundriss_B.pdf')] }),
          }),
          canManage: true,
        }),
      )

      const items = within(screen.getByTestId('fassung-supersedes')).getAllByRole('listitem')
      expect(items.map((item) => item.textContent)).toEqual([
        expect.stringContaining('Ersetzt Grundriss_A.pdf.'),
        expect.stringContaining('Ersetzt Grundriss_B.pdf.'),
      ])
    })

    it('unlinks each older Fassung on its own, not only the first', async () => {
      const user = userEvent.setup()
      vi.mocked(setFassungLink).mockResolvedValueOnce(facts({ supersedes: [ref('doc-0', 'Grundriss_A.pdf')] }))
      renderPanel(
        panel({
          file: fileFixture({
            fassung: facts({ supersedes: [ref('doc-0', 'Grundriss_A.pdf'), ref('doc-0b', 'Grundriss_B.pdf')] }),
          }),
          canManage: true,
        }),
      )

      const second = within(screen.getByTestId('fassung-supersedes')).getAllByRole('listitem')[1]
      await user.click(within(second).getByRole('button', { name: 'Verknüpfung lösen' }))

      expect(setFassungLink).toHaveBeenCalledWith('doc-1', 'doc-0b', false)
    })

    it('drops a decision that answers after the rail moved to another file', async () => {
      const user = userEvent.setup()
      let answer: (value: FassungFacts) => void = () => {}
      vi.mocked(setFassungLink).mockReturnValueOnce(new Promise<FassungFacts>((resolve) => (answer = resolve)))
      const first = fileFixture({ fassung: facts({ supersedes: [ref('doc-0', 'Grundriss_A.pdf')] }) })
      const { rerender } = renderPanel(panel({ file: first, canManage: true }))

      await user.click(screen.getByRole('button', { name: 'Verknüpfung lösen' }))
      rerender(panel({ file: fileFixture({ id: 'doc-9', fassung: facts({ supersededBy: ref('doc-8', 'Neu.pdf') }) }), canManage: true }))
      answer(facts({ supersedes: [ref('doc-0', 'Grundriss_A.pdf'), ref('doc-x', 'Fremd.pdf')] }))

      await waitFor(() => expect(screen.getByTestId('fassung-superseded')).toBeInTheDocument())
      expect(screen.queryByText(/Fremd\.pdf/)).toBeNull()
    })

    it('unlinks the older Fassung through setFassungLink with linked=false, and reports the emptied facts', async () => {
      const user = userEvent.setup()
      vi.mocked(setFassungLink).mockResolvedValueOnce(EMPTY_FASSUNG)
      const onFassungChanged = vi.fn()
      renderPanel(
        panel({
          file: fileFixture({ fassung: facts({ supersedes: [ref('doc-0', 'Grundriss_A.pdf')] }) }),
          canManage: true,
          onFassungChanged,
        }),
      )

      await user.click(screen.getByRole('button', { name: 'Verknüpfung lösen' }))

      expect(setFassungLink).toHaveBeenCalledWith('doc-1', 'doc-0', false)
      await waitFor(() => expect(onFassungChanged).toHaveBeenCalledWith('doc-1', EMPTY_FASSUNG))
      expect(screen.queryByTestId('fassung-panel')).toBeNull()
    })

    it('hides the unlink button from a reader who may not manage the folder', () => {
      renderPanel(
        panel({
          file: fileFixture({ fassung: facts({ supersedes: [ref('doc-0', 'Grundriss_A.pdf')] }) }),
          canManage: false,
        }),
      )

      expect(screen.getByTestId('fassung-supersedes')).toHaveTextContent('Ersetzt Grundriss_A.pdf.')
      expect(screen.queryByRole('button', { name: 'Verknüpfung lösen' })).toBeNull()
    })
  })

  describe('the change summary', () => {
    it('renders one list item per bullet line, without the markers the model wrote', () => {
      renderPanel(
        panel({
          file: fileFixture({
            fassung: facts({
              changeSummary: {
                text: '- Dachhöhe: 12 m → 14 m\n• Fenster: Typ A → Typ B\n\n2) Attika neu\n– Entwässerung\n*  Brüstung',
                basis: 'previous',
              },
            }),
          }),
          canManage: true,
        }),
      )

      const items = within(screen.getByTestId('fassung-change'))
        .getAllByRole('listitem')
        .map((item) => item.textContent)
      expect(items).toEqual([
        'Dachhöhe: 12 m → 14 m',
        'Fenster: Typ A → Typ B',
        'Attika neu',
        'Entwässerung',
        'Brüstung',
      ])
    })

    it('says "vorigen Fassung" when the change is against the earlier upload under this name', () => {
      renderPanel(
        panel({
          file: fileFixture({ fassung: facts({ changeSummary: { text: '- Attika neu', basis: 'previous' } }) }),
          canManage: true,
        }),
      )

      expect(screen.getByTestId('fassung-change')).toHaveTextContent(
        'Was sich gegenüber der vorigen Fassung geändert hat:',
      )
    })

    it('names the document it is measured against when the basis is another document', () => {
      renderPanel(
        panel({
          file: fileFixture({
            fassung: facts({
              changeSummary: { text: '- Attika neu', basis: ref('doc-0', 'Grundriss_A.pdf') },
            }),
          }),
          canManage: true,
        }),
      )

      const change = screen.getByTestId('fassung-change')
      expect(change).toHaveTextContent('Was sich gegenüber Grundriss_A.pdf geändert hat:')
      expect(change).not.toHaveTextContent('vorigen Fassung')
    })
  })

  describe('changeLines', () => {
    it('drops blank lines and keeps a line whose text starts with a digit but no marker', () => {
      expect(changeLines('\n  \n2026 Entwurf\n')).toEqual(['2026 Entwurf'])
    })
  })

  describe('a suggestion that this document replaces another', () => {
    it('names the older document and says the file name is why', () => {
      renderPanel(
        panel({
          file: fileFixture({
            fassung: facts({
              suggestion: { of: ref('doc-0', 'Grundriss_B.pdf'), confidence: 0.92, reason: '', basis: 'name' },
            }),
          }),
          canManage: true,
        }),
      )

      const suggestion = screen.getByTestId('fassung-suggestion')
      expect(suggestion).toHaveTextContent('Ist das eine neuere Fassung von Grundriss_B.pdf?')
      expect(suggestion).toHaveTextContent('Index und Datum im Dateinamen sprechen dafür.')
    })

    it('says Piloti read both documents when the basis is the content, and adds its reason', () => {
      renderPanel(
        panel({
          file: fileFixture({
            fassung: facts({
              suggestion: {
                of: ref('doc-0', 'Grundriss_B.pdf'),
                confidence: 0.7,
                reason: 'Gleicher Grundriss, neue Maße.',
                basis: 'content',
              },
            }),
          }),
          canManage: true,
        }),
      )

      expect(screen.getByTestId('fassung-suggestion')).toHaveTextContent(
        'Piloti hat beide gelesen: Gleicher Grundriss, neue Maße.',
      )
      expect(screen.queryByText('Index und Datum im Dateinamen sprechen dafür.')).toBeNull()
    })

    it('confirms through setFassungLink with linked=true, shows the facts it returns, and reports them', async () => {
      const user = userEvent.setup()
      const returned = facts({ supersedes: [ref('doc-0', 'Grundriss_B.pdf')] })
      vi.mocked(setFassungLink).mockResolvedValueOnce(returned)
      const onFassungChanged = vi.fn()
      renderPanel(
        panel({
          file: fileFixture({
            fassung: facts({
              suggestion: { of: ref('doc-0', 'Grundriss_B.pdf'), confidence: 0.9, reason: '', basis: 'name' },
            }),
          }),
          canManage: true,
          onFassungChanged,
        }),
      )

      await user.click(screen.getByRole('button', { name: 'Ja, ersetzt sie' }))

      expect(setFassungLink).toHaveBeenCalledWith('doc-1', 'doc-0', true)
      await waitFor(() => expect(screen.getByTestId('fassung-supersedes')).toHaveTextContent('Ersetzt Grundriss_B.pdf.'))
      expect(screen.queryByTestId('fassung-suggestion')).toBeNull()
      expect(onFassungChanged).toHaveBeenCalledWith('doc-1', returned)
    })

    it('dismisses through setFassungLink with linked=false and takes the suggestion away', async () => {
      const user = userEvent.setup()
      vi.mocked(setFassungLink).mockResolvedValueOnce(EMPTY_FASSUNG)
      renderPanel(
        panel({
          file: fileFixture({
            fassung: facts({
              suggestion: { of: ref('doc-0', 'Grundriss_B.pdf'), confidence: 0.9, reason: '', basis: 'name' },
            }),
          }),
          canManage: true,
        }),
      )

      await user.click(screen.getByRole('button', { name: 'Nein' }))

      expect(setFassungLink).toHaveBeenCalledWith('doc-1', 'doc-0', false)
      await waitFor(() => expect(screen.queryByTestId('fassung-panel')).toBeNull())
    })

    it('disables both answers while the request is in flight', async () => {
      const user = userEvent.setup()
      const pending = deferred<FassungFacts>()
      vi.mocked(setFassungLink).mockReturnValueOnce(pending.promise)
      renderPanel(
        panel({
          file: fileFixture({
            fassung: facts({
              suggestion: { of: ref('doc-0', 'Grundriss_B.pdf'), confidence: 0.9, reason: '', basis: 'name' },
            }),
          }),
          canManage: true,
        }),
      )

      await user.click(screen.getByRole('button', { name: 'Ja, ersetzt sie' }))

      expect(screen.getByRole('button', { name: 'Ja, ersetzt sie' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Nein' })).toBeDisabled()

      await act(async () => pending.resolve(EMPTY_FASSUNG))
      await waitFor(() => expect(screen.queryByTestId('fassung-panel')).toBeNull())
    })

    it('reports a refused request with a toast and keeps the suggestion for another try', async () => {
      const user = userEvent.setup()
      vi.mocked(setFassungLink).mockRejectedValueOnce(new Error('409 conflict'))
      renderPanel(
        panel({
          file: fileFixture({
            fassung: facts({
              suggestion: { of: ref('doc-0', 'Grundriss_B.pdf'), confidence: 0.9, reason: '', basis: 'name' },
            }),
          }),
          canManage: true,
        }),
      )

      await user.click(screen.getByRole('button', { name: 'Ja, ersetzt sie' }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Die Fassung konnte nicht gespeichert werden.'))
      expect(screen.getByTestId('fassung-suggestion')).toHaveTextContent('Ist das eine neuere Fassung von Grundriss_B.pdf?')
      expect(screen.getByRole('button', { name: 'Ja, ersetzt sie' })).toBeEnabled()
    })

    it('shows neither answer, but says who may answer, to a reader who may not manage the folder', () => {
      renderPanel(
        panel({
          file: fileFixture({
            fassung: facts({
              suggestion: { of: ref('doc-0', 'Grundriss_B.pdf'), confidence: 0.9, reason: '', basis: 'name' },
            }),
          }),
          canManage: false,
        }),
      )

      expect(screen.getByTestId('fassung-suggestion')).toHaveTextContent('Ist das eine neuere Fassung von Grundriss_B.pdf?')
      expect(screen.queryByRole('button', { name: 'Ja, ersetzt sie' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Nein' })).toBeNull()
      expect(screen.getByText('Bestätigen kann, wer diesen Ordner bearbeiten darf.')).toBeInTheDocument()
    })
  })

  describe('switching to another file', () => {
    it('shows the new file’s facts, not the decision made on the previous one', async () => {
      const user = userEvent.setup()
      vi.mocked(setFassungLink).mockResolvedValueOnce(facts({ supersedes: [ref('doc-0', 'Grundriss_B.pdf')] }))
      const first = fileFixture({
        id: 'doc-1',
        fassung: facts({ suggestion: { of: ref('doc-0', 'Grundriss_B.pdf'), confidence: 0.9, reason: '', basis: 'name' } }),
      })
      const { rerender } = renderPanel(panel({ file: first, canManage: true }))

      await user.click(screen.getByRole('button', { name: 'Ja, ersetzt sie' }))
      await waitFor(() => expect(screen.getByTestId('fassung-supersedes')).toBeInTheDocument())

      const second = fileFixture({
        id: 'doc-9',
        filename: 'Schnitt_AA.pdf',
        fassung: facts({ supersededBy: ref('doc-8', 'Schnitt_AB.pdf') }),
      })
      rerender(panel({ file: second, canManage: true }))

      expect(screen.queryByTestId('fassung-supersedes')).toBeNull()
      expect(screen.getByTestId('fassung-superseded')).toHaveTextContent('Ersetzt durch Schnitt_AB.pdf.')
    })

    it('goes quiet when the new file has no Fassung facts', async () => {
      const { rerender } = renderPanel(
        panel({
          file: fileFixture({ fassung: facts({ supersedes: [ref('doc-0', 'Grundriss_A.pdf')] }) }),
          canManage: true,
        }),
      )
      expect(screen.getByTestId('fassung-panel')).toBeInTheDocument()

      rerender(panel({ file: fileFixture({ id: 'doc-2', fassung: null }), canManage: true }))

      expect(screen.queryByTestId('fassung-panel')).toBeNull()
    })
  })
})
