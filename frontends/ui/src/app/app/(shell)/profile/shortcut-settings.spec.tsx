import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, test, expect, beforeEach } from 'vitest'
import { ShortcutSettings } from './shortcut-settings'
import { SHORTCUTS_PREFERENCE_KEY } from '@/hooks/use-shortcuts-preference'

describe('ShortcutSettings', () => {
  beforeEach(() => {
    window.localStorage.removeItem(SHORTCUTS_PREFERENCE_KEY)
  })

  test('defaults to ON when nothing is stored', () => {
    render(<ShortcutSettings />)

    expect(screen.getByRole('switch', { name: 'Enable keyboard shortcuts' })).toBeChecked()
  })

  test('turning the toggle off persists the choice', async () => {
    render(<ShortcutSettings />)

    const toggle = screen.getByRole('switch', { name: 'Enable keyboard shortcuts' })
    await userEvent.click(toggle)

    expect(toggle).not.toBeChecked()
    expect(window.localStorage.getItem(SHORTCUTS_PREFERENCE_KEY)).toBe('false')
  })

  test('reflects a stored OFF choice and can turn shortcuts back on', async () => {
    window.localStorage.setItem(SHORTCUTS_PREFERENCE_KEY, 'false')
    render(<ShortcutSettings />)

    const toggle = screen.getByRole('switch', { name: 'Enable keyboard shortcuts' })
    expect(toggle).not.toBeChecked()

    await userEvent.click(toggle)
    expect(toggle).toBeChecked()
    expect(window.localStorage.getItem(SHORTCUTS_PREFERENCE_KEY)).toBe('true')
  })
})
