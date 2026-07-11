import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { CodeBlock } from './CodeBlock'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import { toast } from 'sonner'

describe('CodeBlock — clipboard copy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('copies the value and shows the success state on success', async () => {
    // setup() first — userEvent installs its own clipboard stub; override after.
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    render(<CodeBlock value="const a = 1" language="ts" />)
    await user.click(screen.getByRole('button', { name: /copy code/i }))

    expect(writeText).toHaveBeenCalledWith('const a = 1')
    await waitFor(() => expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument())
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('surfaces a toast when the clipboard write fails', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    render(<CodeBlock value="secret" language="ts" />)
    await user.click(screen.getByRole('button', { name: /copy code/i }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not copy'))
    // Success state must not appear on failure.
    expect(screen.queryByRole('button', { name: /copied/i })).not.toBeInTheDocument()
  })
})
