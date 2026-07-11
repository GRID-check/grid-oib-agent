import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { CreateProjectDialog } from './create-project-dialog'

const replace = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/app/projects',
}))

// The form pulls in a server action; the dialog behaviour under test does not
// depend on it, so stub it out to keep the test focused and hermetic.
vi.mock('./create-project-form', () => ({
  CreateProjectForm: () => <div data-testid="create-project-form" />,
}))

describe('CreateProjectDialog', () => {
  beforeEach(() => {
    replace.mockClear()
  })

  test('auto-opens when defaultOpen and strips ?new=1 on close', async () => {
    render(<CreateProjectDialog defaultOpen />)

    // Auto-opened: the form is visible.
    expect(await screen.findByTestId('create-project-form')).toBeDefined()

    // Close via Escape.
    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/app/projects', { scroll: false }))
  })

  test('does not rewrite the URL when it was not auto-opened', async () => {
    render(<CreateProjectDialog />)

    // Open then close the manually-triggered dialog.
    await userEvent.click(screen.getByRole('button', { name: /New project/i }))
    expect(await screen.findByTestId('create-project-form')).toBeDefined()
    await userEvent.keyboard('{Escape}')

    await waitFor(() =>
      expect(screen.queryByTestId('create-project-form')).toBeNull(),
    )
    expect(replace).not.toHaveBeenCalled()
  })
})
