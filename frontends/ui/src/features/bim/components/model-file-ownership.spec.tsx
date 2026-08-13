import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import type { BimModelHeaderView } from '../hooks/use-bim-model'
import { ModelFileOwnership } from './model-file-ownership'

const askAboutFile = vi.fn()
const routerPush = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (...args: unknown[]) => routerPush(...args) }),
}))

vi.mock('@/features/documents/lib/ask-about-file', () => ({
  askAboutFile: (...args: unknown[]) => askAboutFile(...args),
}))

function model(overrides: Partial<BimModelHeaderView> = {}): BimModelHeaderView {
  return {
    id: 'm-1',
    documentId: 'doc-1',
    projectId: 'p1',
    filename: 'Haus-A.ifc',
    displayName: null,
    status: 'ready',
    schemaVersion: 'IFC4',
    elementCount: 12,
    errorMessage: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    summary: null,
    ...overrides,
  }
}

describe('ModelFileOwnership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    server.resetHandlers()
  })

  it('offers Ask on a ready model', async () => {
    render(<ModelFileOwnership projectId="p1" model={model()} canCollaborate={false} />)
    await userEvent.click(screen.getByTestId('stage-ask'))
    expect(askAboutFile).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        file: expect.objectContaining({ id: 'doc-1', filename: 'Haus-A.ifc' }),
      }),
    )
  })

  it('does not offer Ask while the model is still being read', () => {
    render(
      <ModelFileOwnership
        projectId="p1"
        model={model({ status: 'extracting' })}
        canCollaborate={false}
      />,
    )
    expect(screen.queryByTestId('stage-ask')).not.toBeInTheDocument()
  })

  it('shows responsible people when collaboration is on', async () => {
    server.use(
      http.get('/api/assignments/document/:id', () =>
        HttpResponse.json({
          assignees: [{ userId: 'u1', name: 'Anna', email: 'anna@grid.test', profilePictureUrl: null }],
        }),
      ),
    )
    render(<ModelFileOwnership projectId="p1" model={model()} canCollaborate />)
    expect(await screen.findByTestId('stage-assignees')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTitle('Anna')).toBeInTheDocument())
    expect(screen.getByTestId('stage-assign')).toBeInTheDocument()
  })

  it('hides assignment when collaboration is off', () => {
    render(<ModelFileOwnership projectId="p1" model={model()} canCollaborate={false} />)
    expect(screen.queryByTestId('stage-assign')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stage-assignees')).not.toBeInTheDocument()
  })
})
