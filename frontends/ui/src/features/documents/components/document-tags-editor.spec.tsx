import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DocumentTagsEditor } from './document-tags-editor'

/**
 * The tag editor on its own: the chips, the add-tag input, the controlled
 * vocabulary and the PATCH that persists every change. The pane and the
 * reading block are specced in their own files; what they assert about the
 * editor is only that it is there, not how it behaves.
 */
describe('DocumentTagsEditor', () => {
  const okResponse = { ok: true, json: async () => ({}) } as Response

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const tagsCall = (fetchMock: { mock: { calls: unknown[][] } }) =>
    fetchMock.mock.calls.find(([url]) => String(url) === '/api/documents/doc-1/tags')

  it('renders the initial tags as removable chips', () => {
    render(<DocumentTagsEditor fileId="doc-1" initialTags={['Grundriss', 'Brandschutz']} />)

    expect(screen.getByRole('button', { name: 'Remove tag Grundriss' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove tag Brandschutz' })).toBeInTheDocument()
  })

  it('offers the add-tag input when there are no tags yet', () => {
    render(<DocumentTagsEditor fileId="doc-1" initialTags={[]} />)

    expect(screen.getByRole('textbox', { name: /add tag/i })).toBeInTheDocument()
  })

  it('renders a read-only placeholder and no input or × when readOnly', () => {
    render(<DocumentTagsEditor fileId="doc-1" initialTags={[]} readOnly />)

    expect(screen.getByText('No tags')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /add tag/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /remove tag/i })).toBeNull()
  })

  it('adds a tag typed into the input on Enter: optimistic chip + PATCH shape', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse)

    render(<DocumentTagsEditor fileId="doc-1" initialTags={['Grundriss']} />)

    await user.type(screen.getByRole('textbox', { name: /add tag/i }), 'Brandschutz{Enter}')

    // Optimistic: the new chip is present immediately.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove tag Brandschutz' })).toBeInTheDocument()
    )

    const call = tagsCall(fetchMock)
    expect(call).toBeDefined()
    expect(call![1]).toMatchObject({ method: 'PATCH' })
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
      tags: ['Grundriss', 'Brandschutz'],
    })
  })

  it('offers vocabulary suggestions while typing and adds one on click', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse)

    render(<DocumentTagsEditor fileId="doc-1" initialTags={[]} />)

    await user.type(screen.getByRole('textbox', { name: /add tag/i }), 'schall')
    await user.click(await screen.findByRole('button', { name: 'Schallschutz' }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove tag Schallschutz' })).toBeInTheDocument()
    )
    expect(JSON.parse((tagsCall(fetchMock)![1] as RequestInit).body as string)).toEqual({
      tags: ['Schallschutz'],
    })
  })

  it('does not add free-form values outside the controlled vocabulary', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse)

    render(<DocumentTagsEditor fileId="doc-1" initialTags={[]} />)

    await user.type(screen.getByRole('textbox', { name: /add tag/i }), 'made-up-tag{Enter}')

    expect(screen.getByText(/no matching tag/i)).toBeInTheDocument()
    expect(tagsCall(fetchMock)).toBeUndefined()
  })

  it('removes a tag via its × affordance and PATCHes the remainder', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse)

    render(<DocumentTagsEditor fileId="doc-1" initialTags={['Grundriss', 'Brandschutz']} />)

    await user.click(screen.getByRole('button', { name: 'Remove tag Brandschutz' }))

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove tag Brandschutz' })).toBeNull()
    )
    const call = tagsCall(fetchMock)
    expect(call![1]).toMatchObject({ method: 'PATCH' })
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
      tags: ['Grundriss'],
    })
  })

  it('notifies the parent with the saved tags after a successful PATCH', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse)
    const onTagsUpdated = vi.fn()

    render(
      <DocumentTagsEditor fileId="doc-1" initialTags={['Grundriss']} onTagsUpdated={onTagsUpdated} />
    )

    await user.type(screen.getByRole('textbox', { name: /add tag/i }), 'Brandschutz{Enter}')

    await waitFor(() =>
      expect(onTagsUpdated).toHaveBeenCalledWith('doc-1', ['Grundriss', 'Brandschutz'])
    )
  })

  it('does not notify the parent and reverts the optimistic chip when the PATCH fails', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response)
    const onTagsUpdated = vi.fn()

    render(
      <DocumentTagsEditor fileId="doc-1" initialTags={['Grundriss']} onTagsUpdated={onTagsUpdated} />
    )

    await user.type(screen.getByRole('textbox', { name: /add tag/i }), 'Brandschutz{Enter}')

    // Optimistic chip appears, then reverts once the PATCH failure lands.
    // (Query the chip via its remove affordance — the plain text also occurs
    // in the suggestion list while the input is focused.)
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove tag Brandschutz' })).toBeNull()
    )
    expect(screen.getByRole('button', { name: 'Remove tag Grundriss' })).toBeInTheDocument()
    expect(onTagsUpdated).not.toHaveBeenCalled()
  })

  it('adopts tags that arrive after it was rendered', () => {
    const { rerender } = render(<DocumentTagsEditor fileId="doc-1" initialTags={[]} />)
    expect(screen.queryByRole('button', { name: 'Remove tag Brandschutz' })).toBeNull()

    rerender(<DocumentTagsEditor fileId="doc-1" initialTags={['Brandschutz']} />)

    expect(screen.getByRole('button', { name: 'Remove tag Brandschutz' })).toBeInTheDocument()
  })

  it('does not let tags from a read replace a save that is still in flight', async () => {
    let finishSave: (r: Response) => void = () => undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finishSave = resolve
        })
    )
    const { rerender } = render(
      <DocumentTagsEditor fileId="doc-1" initialTags={['Grundriss', 'Brandschutz']} />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Remove tag Brandschutz' }))

    // A poll that read the row before the save landed.
    rerender(<DocumentTagsEditor fileId="doc-1" initialTags={['Grundriss', 'Brandschutz', 'Statik']} />)

    expect(screen.queryByRole('button', { name: 'Remove tag Brandschutz' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove tag Statik' })).toBeNull()

    finishSave(okResponse)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove tag Grundriss' })).toBeInTheDocument()
    )
  })
})
