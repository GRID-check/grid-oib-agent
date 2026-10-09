import { beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { GeneralSettings } from './general-settings'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
vi.mock('../project-danger-zone', () => ({
  ProjectDangerZone: () => <div data-testid="project-danger-zone" />,
}))

const props = {
  projectId: 'p1',
  projectName: 'Alpine Tower',
  createdAt: '2026-07-01T10:00:00Z',
  documentCount: 12,
  totalFileSize: 48_000_000,
}

beforeEach(() => {
  refresh.mockReset()
  vi.restoreAllMocks()
})

describe('GeneralSettings', () => {
  test('a viewer sees the name, disabled with the reason, and no danger zone', () => {
    render(<GeneralSettings {...props} canManage={false} />)

    expect(screen.getByLabelText('Project name')).toHaveValue('Alpine Tower')
    expect(screen.getByLabelText('Project name')).toBeDisabled()
    expect(screen.getByText('Only project admins can rename the project.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-danger-zone')).not.toBeInTheDocument()
  })

  test('shows the size facts and links to the files', () => {
    render(<GeneralSettings {...props} canManage={false} />)

    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open files' })).toHaveAttribute(
      'href',
      '/app/projects/p1/files'
    )
  })

  test('an admin renames in place, and Save waits for a real change', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}))
    render(<GeneralSettings {...props} canManage />)

    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()

    const field = screen.getByLabelText('Project name')
    await userEvent.clear(field)
    expect(screen.getByText('Enter a name.')).toBeInTheDocument()
    expect(save).toBeDisabled()

    await userEvent.type(field, '  Alpine Tower II ')
    await userEvent.click(save)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/p1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Alpine Tower II' }) })
    )
    expect(refresh).toHaveBeenCalled()
    // The saved name is the new baseline: nothing left to save.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByTestId('project-danger-zone')).toBeInTheDocument()
  })
})
