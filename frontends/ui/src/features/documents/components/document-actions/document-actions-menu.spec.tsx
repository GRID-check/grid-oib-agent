/**
 * The file-operations menu, on its own.
 *
 * Spec'd here rather than only through the workspaces because this control is
 * the product's single answer to "what can I do to this document" — it is
 * mounted by the file preview, the Büroarchiv and the model viewport, and a
 * regression in any of its three items is a regression on all three surfaces.
 *
 * What is asserted is the BEHAVIOUR the heuristics called for: an irreversible
 * operation asks first and names what it will destroy, a reversible one does
 * not, a failure leaves the decision on screen instead of vanishing, and a
 * viewer who may not mutate is offered nothing that mutates.
 */

import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import { DocumentActionsMenu } from './document-actions-menu'

const DOCUMENT = { id: 'doc-1', filename: 'Einreichplan_EG.pdf', displayName: null }

const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByTestId('document-actions-trigger'))
}

describe('DocumentActionsMenu — what it offers', () => {
  it('carries download, rename and delete by default, with delete set apart', async () => {
    const user = userEvent.setup()
    render(<DocumentActionsMenu document={DOCUMENT} scope="files" />)
    await openMenu(user)

    expect(await screen.findByRole('menuitem', { name: /download/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /rename/i })).toBeInTheDocument()
    const remove = screen.getByRole('menuitem', { name: /delete/i })
    expect(remove).toHaveAttribute('data-variant', 'destructive')
  })

  it('offers only what the surface asked for', async () => {
    const user = userEvent.setup()
    // The file preview shows a Download button of its own; two controls for one
    // job is worse than a shorter menu.
    render(<DocumentActionsMenu document={DOCUMENT} scope="files" actions={['rename', 'delete']} />)
    await openMenu(user)

    expect(await screen.findByRole('menuitem', { name: /rename/i })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /download/i })).not.toBeInTheDocument()
  })

  it('renders nothing at all when a read-only viewer would see an empty menu', () => {
    render(
      <DocumentActionsMenu
        document={DOCUMENT}
        scope="archiv"
        actions={['rename', 'delete']}
        canManage={false}
      />
    )
    expect(screen.queryByTestId('document-actions-trigger')).not.toBeInTheDocument()
  })

  it('keeps download for a read-only viewer and drops the mutations', async () => {
    const user = userEvent.setup()
    render(<DocumentActionsMenu document={DOCUMENT} scope="archiv" canManage={false} />)
    await openMenu(user)

    expect(await screen.findByRole('menuitem', { name: /download/i })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /rename/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /delete/i })).not.toBeInTheDocument()
  })
})

describe('DocumentActionsMenu — deleting', () => {
  it('asks first, names the document, and reports it upward on confirm', async () => {
    server.use(http.delete('/api/documents/:id', () => new HttpResponse(null, { status: 204 })))
    const onDeleted = vi.fn()
    const user = userEvent.setup()
    render(<DocumentActionsMenu document={DOCUMENT} scope="files" onDeleted={onDeleted} />)

    await openMenu(user)
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }))

    expect(await screen.findByText('Delete “Einreichplan_EG.pdf”?')).toBeInTheDocument()
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument()

    await user.click(screen.getByTestId('document-delete-confirm'))
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('doc-1'))
  })

  it('deletes an Archiv document through the org-scoped route', async () => {
    const hits: string[] = []
    server.use(
      http.delete('/api/archiv/documents/:id', ({ params }) => {
        hits.push(String(params.id))
        return new HttpResponse(null, { status: 204 })
      })
    )
    const user = userEvent.setup()
    render(<DocumentActionsMenu document={DOCUMENT} scope="archiv" />)

    await openMenu(user)
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }))
    await user.click(await screen.findByTestId('document-delete-confirm'))

    await waitFor(() => expect(hits).toEqual(['doc-1']))
  })

  it('leaves the question on screen when the delete fails', async () => {
    server.use(http.delete('/api/documents/:id', () => new HttpResponse(null, { status: 500 })))
    const onDeleted = vi.fn()
    const user = userEvent.setup()
    render(<DocumentActionsMenu document={DOCUMENT} scope="files" onDeleted={onDeleted} />)

    await openMenu(user)
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }))
    await user.click(await screen.findByTestId('document-delete-confirm'))

    // A dialog that vanishes while the document is still there would report a
    // deletion that did not happen.
    await waitFor(() => expect(screen.getByTestId('document-delete-confirm')).toBeInTheDocument())
    expect(onDeleted).not.toHaveBeenCalled()
  })
})

describe('DocumentActionsMenu — renaming', () => {
  const renameRoute = (captured: Array<Record<string, unknown>>) =>
    http.patch('/api/documents/:id', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>
      captured.push(body)
      return HttpResponse.json({ id: 'doc-1', filename: DOCUMENT.filename, ...body })
    })

  it('edits the stem, keeps the extension, and reports the stored name upward', async () => {
    const captured: Array<Record<string, unknown>> = []
    server.use(renameRoute(captured))
    const onRenamed = vi.fn()
    const user = userEvent.setup()
    render(<DocumentActionsMenu document={DOCUMENT} scope="files" onRenamed={onRenamed} />)

    await openMenu(user)
    await user.click(await screen.findByRole('menuitem', { name: /rename/i }))

    // The field opens on the stem alone, and the extension is shown beside it.
    const field = await screen.findByLabelText('Name')
    expect(field).toHaveValue('Einreichplan_EG')
    expect(screen.getByTestId('rename-extension')).toHaveTextContent('.pdf')

    await user.clear(field)
    await user.type(field, 'Einreichplan Erdgeschoss')
    await user.click(screen.getByTestId('rename-submit'))

    await waitFor(() => expect(captured).toEqual([{ displayName: 'Einreichplan Erdgeschoss.pdf' }]))
    expect(onRenamed).toHaveBeenCalledWith('doc-1', 'Einreichplan Erdgeschoss.pdf')
  })

  it('refuses a name with a path separator before anything is sent', async () => {
    const captured: Array<Record<string, unknown>> = []
    server.use(renameRoute(captured))
    const user = userEvent.setup()
    render(<DocumentActionsMenu document={DOCUMENT} scope="files" />)

    await openMenu(user)
    await user.click(await screen.findByRole('menuitem', { name: /rename/i }))
    const field = await screen.findByLabelText('Name')
    await user.clear(field)
    await user.type(field, 'Pläne/EG')
    await user.click(screen.getByTestId('rename-submit'))

    expect(await screen.findByRole('alert')).toHaveTextContent(/slashes or line breaks/i)
    expect(captured).toEqual([])
    // The dialog stays open on the value that was refused, so it can be fixed.
    expect(screen.getByLabelText('Name')).toHaveValue('Pläne/EG')
  })

  it('offers to restore the original name, and only once there is one to restore', async () => {
    const captured: Array<Record<string, unknown>> = []
    server.use(renameRoute(captured))
    const user = userEvent.setup()
    const { rerender } = render(<DocumentActionsMenu document={DOCUMENT} scope="files" />)

    await openMenu(user)
    await user.click(await screen.findByRole('menuitem', { name: /rename/i }))
    expect(screen.queryByRole('button', { name: /restore original name/i })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')

    rerender(
      <DocumentActionsMenu
        document={{ ...DOCUMENT, displayName: 'Einreichplan Erdgeschoss.pdf' }}
        scope="files"
      />
    )
    await openMenu(user)
    await user.click(await screen.findByRole('menuitem', { name: /rename/i }))
    await user.click(await screen.findByRole('button', { name: /restore original name/i }))

    // `null` is the clear — the server drops the override and the file's own
    // name applies again.
    await waitFor(() => expect(captured).toEqual([{ displayName: null }]))
  })

  describe('a document that failed to index', () => {
    const FAILED = { ...DOCUMENT, status: 'failed' }

    it('offers the retry where the failure is shown', async () => {
      // The card already says WHY it failed, in destructive red, and until this
      // moved the only retry in the product was two clicks inside a viewer the
      // reader had no reason to open — they had just been told the bad news on
      // the card.
      const user = userEvent.setup()
      render(<DocumentActionsMenu document={FAILED} scope="files" />)
      await user.click(screen.getByTestId('document-actions-trigger'))

      expect(await screen.findByTestId('document-action-reingest')).toBeInTheDocument()
    })

    it('does not offer it for a healthy document', async () => {
      // A "try again" on a document that is fine is an invitation to re-run an
      // expensive pipeline for nothing.
      const user = userEvent.setup()
      render(<DocumentActionsMenu document={DOCUMENT} scope="files" />)
      await user.click(screen.getByTestId('document-actions-trigger'))

      expect(await screen.findByTestId('document-action-download')).toBeInTheDocument()
      expect(screen.queryByTestId('document-action-reingest')).not.toBeInTheDocument()
    })

    it('does not offer it to a reader who may not manage the document', async () => {
      const user = userEvent.setup()
      render(<DocumentActionsMenu document={FAILED} scope="files" canManage={false} />)
      await user.click(screen.getByTestId('document-actions-trigger'))

      expect(await screen.findByTestId('document-action-download')).toBeInTheDocument()
      expect(screen.queryByTestId('document-action-reingest')).not.toBeInTheDocument()
    })

    it('sends it back through ingestion and reports the new status', async () => {
      let asked = 0
      server.use(
        http.post('/api/documents/doc-1/reingest', () => {
          asked += 1
          return HttpResponse.json({ status: 'pending' })
        }),
      )
      const user = userEvent.setup()
      const onReingested = vi.fn()
      render(<DocumentActionsMenu document={FAILED} scope="files" onReingested={onReingested} />)

      await user.click(screen.getByTestId('document-actions-trigger'))
      await user.click(await screen.findByTestId('document-action-reingest'))

      await waitFor(() => expect(onReingested).toHaveBeenCalledWith('doc-1', 'pending'))
      expect(asked).toBe(1)
    })
  })
})

/**
 * Moving a document between folders.
 *
 * The one thing folders could not do: a file was filed AT UPLOAD and
 * `documents.folder_id` had no second writer, so a document dropped in the
 * wrong folder — or uploaded before the folder existed — stayed there for good.
 *
 * What is asserted here is what the menu OFFERS. Choosing a destination is NOT:
 * jsdom does not deliver a synthetic click to a Radix submenu item (the native
 * event fires on the node, React's synthetic one never runs), so a test of the
 * selection would be a test of jsdom. That half is verified in a real browser by
 * the `document-actions-moved` screenshot fixture, which drives the same click
 * against a shimmed PATCH and prints what reached `onMoved`; the request itself
 * is pinned in `src/lib/documents/move-to-folder.spec.ts`.
 */
describe('DocumentActionsMenu — moving between folders', () => {
  const FOLDERS = [
    { id: 'f-brand', name: 'Brandschutz', parentId: null },
    { id: 'f-flucht', name: 'Fluchtwege', parentId: 'f-brand' },
    { id: 'f-statik', name: 'Statik', parentId: null },
  ]

  const openMove = async (user: ReturnType<typeof userEvent.setup>) => {
    await openMenu(user)
    await user.click(await screen.findByTestId('document-action-move'))
  }

  it('is not offered when there is nowhere to move it to', async () => {
    const user = userEvent.setup()
    render(<DocumentActionsMenu document={DOCUMENT} scope="files" />)
    await openMenu(user)

    // An empty submenu is worse than no submenu: it costs a click to learn
    // there was nothing there.
    expect(screen.queryByTestId('document-action-move')).not.toBeInTheDocument()
  })

  it('names a nested folder by its whole path, not just its own name', async () => {
    const user = userEvent.setup()
    render(<DocumentActionsMenu document={DOCUMENT} scope="files" folders={FOLDERS} />)
    await openMove(user)

    // Two projects can both have a "Fluchtwege"; the path is what tells them
    // apart without making the reader walk the tree to find out.
    expect(await screen.findByRole('menuitem', { name: /Brandschutz \/ Fluchtwege/ })).toBeInTheDocument()
  })

  it('offers the project root, and disables whichever folder it is already in', async () => {
    const user = userEvent.setup()
    render(
      <DocumentActionsMenu
        document={{ ...DOCUMENT, folderId: 'f-statik' }}
        scope="files"
        folders={FOLDERS}
        onMoved={vi.fn()}
      />,
    )
    await openMove(user)

    // "Move it to where it already is" is not a destination.
    expect(await screen.findByRole('menuitem', { name: /^Statik$/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    // And getting a document OUT of every folder is a real destination.
    expect(screen.getByTestId('document-move-root')).not.toHaveAttribute('aria-disabled', 'true')
  })

})
