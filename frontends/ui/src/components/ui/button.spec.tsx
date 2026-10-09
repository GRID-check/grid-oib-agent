import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Button } from './button'

describe('Button loading', () => {
  it('swallows a second press but keeps the focus it had', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    const { rerender } = render(<Button onClick={onClick}>Speichern</Button>)
    const button = screen.getByRole('button', { name: 'Speichern' })
    await user.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)

    // Disabling a focused button blurs it in Chrome: the keyboard reader lands
    // on <body>. Loading must not do that.
    rerender(
      <Button onClick={onClick} loading>
        Speichern
      </Button>
    )
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveFocus()
    await user.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('does not submit its form while loading', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" loading>
          Senden
        </Button>
      </form>
    )
    await user.click(screen.getByRole('button', { name: 'Senden' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
