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
})
