/**
 * The answer's way out of the app.
 *
 * What matters here is not that a button exists but WHAT lands on the
 * clipboard: source markdown (numbering, tables, emphasis intact), never the
 * rendered text, and never the internal `[[card:N]]` machinery. Plus the two
 * refusals — no dead "with sources" button on an answer that has none, and no
 * silent failure when the clipboard is blocked.
 */

import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { AnswerActions } from './AnswerActions'
import { buildCitationModel } from '../lib/citations'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))

const documents = buildCitationModel({
  citations: [
    {
      id: 'c1',
      content: '',
      timestamp: new Date('2026-08-18T09:00:00Z'),
      title: 'OIB-Richtlinie 2 – Brandschutz, Ausgabe Mai 2023',
      fileName: 'oib-rl_2_ausgabe_mai_2023.pdf',
      collection: 'oib_knowledge',
      kind: 'baurecht',
      origin: 'kb',
      page: 18,
      number: 1,
      isCited: true,
    },
  ],
})

const ANSWER =
  'Die Fluchtweglänge ist auf **40 m** begrenzt [1].\n\n[[card:1]]\n\n' +
  '| Gebäudeklasse | Länge |\n| --- | --- |\n| GK 4 | 40 m |'

describe('AnswerActions', () => {
  let writeText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    writeText = vi.fn().mockResolvedValue(undefined)
  })

  /**
   * `userEvent.setup()` installs its own clipboard stub on `navigator`, so ours
   * has to be written over it AFTERWARDS — same order `CopyCitation.spec` uses.
   */
  const installClipboard = () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })
  }

  const copied = () => writeText.mock.calls[0]![0] as string

  test('copies the answer as markdown — numbering, table and emphasis survive', async () => {
    const user = userEvent.setup()
    render(<AnswerActions content={ANSWER} body={ANSWER} documents={documents} />)
    installClipboard()

    await user.click(screen.getByRole('button', { name: 'Copy answer' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(copied()).toContain('[1]')
    expect(copied()).toContain('**40 m**')
    expect(copied()).toContain('| Gebäudeklasse | Länge |')
  })

  test('never puts the internal card markers on the clipboard', async () => {
    const user = userEvent.setup()
    render(<AnswerActions content={ANSWER} body={ANSWER} documents={documents} />)
    installClipboard()

    await user.click(screen.getByRole('button', { name: 'Copy answer' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(copied()).not.toContain('[[card:')
  })

  test('the second action appends the sources written out in full', async () => {
    const user = userEvent.setup()
    render(<AnswerActions content={ANSWER} body={ANSWER} documents={documents} />)
    installClipboard()

    await user.click(
      screen.getByRole('button', { name: 'Copy answer with full source references' })
    )

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(copied()).toContain('## Sources')
    expect(copied()).toContain('[1] OIB-Richtlinie 2 – Brandschutz, Ausgabe Mai 2023, p. 18')
    expect(copied()).toContain('oib-rl_2_ausgabe_mai_2023.pdf')
  })

  test('renders no "with sources" button when the answer has none', () => {
    render(<AnswerActions content="Nur Prosa." body="Nur Prosa." documents={[]} />)

    expect(screen.getByRole('button', { name: 'Copy answer' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /source references/i })).not.toBeInTheDocument()
  })

  test('confirms with the Check swap, on the pressed button only', async () => {
    const user = userEvent.setup()
    render(<AnswerActions content={ANSWER} body={ANSWER} documents={documents} />)
    installClipboard()

    await user.click(screen.getByRole('button', { name: 'Copy answer' }))

    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    // The other action is untouched — one press, one confirmation.
    expect(
      screen.getByRole('button', { name: 'Copy answer with full source references' })
    ).toBeInTheDocument()
  })

  test('says so when the clipboard refuses instead of failing silently', async () => {
    const user = userEvent.setup()
    writeText.mockRejectedValueOnce(new Error('denied'))
    render(<AnswerActions content={ANSWER} body={ANSWER} documents={documents} />)
    installClipboard()

    await user.click(screen.getByRole('button', { name: 'Copy answer' }))

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument()
  })

  test('is keyboard operable', async () => {
    const user = userEvent.setup()
    render(<AnswerActions content={ANSWER} body={ANSWER} documents={documents} />)
    installClipboard()

    await user.tab()
    expect(screen.getByRole('button', { name: 'Copy answer' })).toHaveFocus()
    await user.keyboard('{Enter}')

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
  })
})
