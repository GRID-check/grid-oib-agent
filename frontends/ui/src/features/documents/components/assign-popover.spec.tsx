/**
 * Assign popover: candidates come from the assignment endpoint, and a failed
 * load is an error — never "no one in this project".
 */

import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor, within } from '@/test-utils'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import { AssignPopover } from './assign-popover'

vi.mock('@/features/chat', () => ({
  useChatStore: (selector: (state: { currentUserId: string }) => unknown) =>
    selector({ currentUserId: 'user_me' }),
}))

const person = (userId: string, name: string) => ({
  userId,
  name,
  email: `${userId}@grid.test`,
  profilePictureUrl: null,
})

async function openPopover(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'Assign' }))
}

describe('AssignPopover', () => {
  it('loads people from GET /api/assignments/document/:id/candidates, not share-invite', async () => {
    const seen: string[] = []
    server.use(
      http.get('/api/assignments/document/:id/candidates', ({ request }) => {
        seen.push(new URL(request.url).pathname)
        return HttpResponse.json({ candidates: [person('user_anna', 'Anna Weber')] })
      }),
      http.get('/api/sharing/:type/:id/candidates', () => {
        seen.push('sharing')
        return HttpResponse.json({ error: 'not-found' }, { status: 404 })
      }),
    )

    render(
      <AssignPopover documentId="doc_1" assignees={[]} onChanged={() => undefined} />,
    )
    await openPopover()

    expect(await screen.findByText('Anna Weber')).toBeInTheDocument()
    expect(seen).toEqual(['/api/assignments/document/doc_1/candidates'])
    expect(screen.queryByText('No one in this project yet')).not.toBeInTheDocument()
  })

  it('shows a real error (not the empty-project copy) when the list fails', async () => {
    server.use(
      http.get('/api/assignments/document/:id/candidates', () =>
        HttpResponse.json({ error: 'not-found' }, { status: 404 }),
      ),
    )

    render(
      <AssignPopover documentId="doc_1" assignees={[]} onChanged={() => undefined} />,
    )
    await openPopover()

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load people')
    expect(screen.queryByText('No one in this project yet')).not.toBeInTheDocument()
  })

  it('says so when making someone responsible is refused', async () => {
    server.use(
      http.get('/api/assignments/document/:id/candidates', () =>
        HttpResponse.json({ candidates: [person('user_anna', 'Anna Weber')] }),
      ),
      http.post('/api/assignments/document/:id', () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    )
    const onChanged = vi.fn()

    render(<AssignPopover documentId="doc_1" assignees={[]} onChanged={onChanged} />)
    await openPopover()
    await userEvent.click(await screen.findByRole('button', { name: /Anna Weber/ }))

    // The write used to `return` on a non-ok response: the row simply did not
    // change, which in a popover about who is responsible reads as success.
    expect(await screen.findByTestId('assign-write-error')).toHaveTextContent('Anna Weber')
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('retries the SAME assignment after it failed', async () => {
    let attempts = 0
    server.use(
      http.get('/api/assignments/document/:id/candidates', () =>
        HttpResponse.json({ candidates: [person('user_anna', 'Anna Weber')] }),
      ),
      http.post('/api/assignments/document/:id', () => {
        attempts += 1
        return attempts === 1
          ? HttpResponse.json({ error: 'boom' }, { status: 500 })
          : HttpResponse.json({ assignees: [person('user_anna', 'Anna Weber')] })
      }),
    )
    const onChanged = vi.fn()

    render(<AssignPopover documentId="doc_1" assignees={[]} onChanged={onChanged} />)
    await openPopover()
    await userEvent.click(await screen.findByRole('button', { name: /Anna Weber/ }))
    await screen.findByTestId('assign-write-error')

    await userEvent.click(within(screen.getByTestId('assign-write-error')).getByRole('button'))

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(attempts).toBe(2)
    expect(screen.queryByTestId('assign-write-error')).not.toBeInTheDocument()
  })

  it('retries the assignment candidates route after a failure', async () => {
    let calls = 0
    server.use(
      http.get('/api/assignments/document/:id/candidates', () => {
        calls += 1
        if (calls === 1) return HttpResponse.json({ error: 'not-found' }, { status: 404 })
        return HttpResponse.json({ candidates: [person('user_bob', 'Bob Klein')] })
      }),
    )

    render(
      <AssignPopover documentId="doc_1" assignees={[]} onChanged={() => undefined} />,
    )
    await openPopover()
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('Bob Klein')).toBeInTheDocument()
    await waitFor(() => expect(calls).toBe(2))
  })
})
