/**
 * „Stilllegen" says what it does before it does it.
 *
 * It is also no longer called „Archivieren", and that is the other half of the
 * report: this product's Archiv is the office archive a document is put INTO to
 * become cross-project Bürowissen, while this act takes it out of the working
 * set and purges its knowledge-base entries. One verb for a thing and its
 * inverse.
 *
 * The reported failure, in the reporter's words: no idea what archiving a
 * document does. It fired on one click from a row of review verbs, and the two
 * consequences nobody guesses from the word — Piloti stops citing the file, and
 * nothing in the product brings it back — were written down only in a service
 * docstring.
 *
 * So what is asserted here is the ceremony: the act cannot reach the server
 * without the reader having been shown all four consequences.
 */

import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test-utils'
import { DocumentArchiveAction } from './document-archive-action'

describe('DocumentArchiveAction', () => {
  it('does not archive on the first click', async () => {
    const onArchive = vi.fn()
    render(<DocumentArchiveAction filename="Aktenvermerk.pdf" onArchive={onArchive} />)

    await userEvent.click(screen.getByTestId('document-lifecycle-archive'))

    expect(onArchive).not.toHaveBeenCalled()
    expect(await screen.findByTestId('document-archive-consequences')).toBeInTheDocument()
  })

  it('states the four consequences, including the two that surprise people', async () => {
    render(<DocumentArchiveAction filename="Aktenvermerk.pdf" onArchive={() => undefined} />)
    await userEvent.click(screen.getByTestId('document-lifecycle-archive'))

    const list = await screen.findByTestId('document-archive-consequences')
    expect(list.children).toHaveLength(4)
    // It leaves the listing, and how to find it again.
    expect(list).toHaveTextContent('Also show retired')
    // Piloti stops citing it — the half that changes what the agent answers.
    expect(list).toHaveTextContent('stops citing it')
    // It is not a delete…
    expect(list).toHaveTextContent('not a delete')
    // …and it is still a one-way door, because no surface un-archives.
    expect(list).toHaveTextContent('cannot be undone')
  })

  it('names the file in the question', async () => {
    render(<DocumentArchiveAction filename="Aktenvermerk.pdf" onArchive={() => undefined} />)
    await userEvent.click(screen.getByTestId('document-lifecycle-archive'))

    expect(await screen.findByRole('dialog')).toHaveTextContent('Aktenvermerk.pdf')
  })

  it('archives once the reader confirms', async () => {
    const onArchive = vi.fn()
    render(<DocumentArchiveAction filename="Aktenvermerk.pdf" onArchive={onArchive} />)

    await userEvent.click(screen.getByTestId('document-lifecycle-archive'))
    await userEvent.click(await screen.findByTestId('document-archive-confirm'))

    expect(onArchive).toHaveBeenCalledTimes(1)
  })
})
