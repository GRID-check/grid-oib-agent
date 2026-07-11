import { renderHook } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import { describe, test, expect, vi } from 'vitest'
import { useEscapeKey } from './use-escape-key'

describe('useEscapeKey', () => {
  test('fires onEscape on Escape when enabled', () => {
    const onEscape = vi.fn()
    renderHook(() => useEscapeKey(true, onEscape))

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  test('ignores non-Escape keys', () => {
    const onEscape = vi.fn()
    renderHook(() => useEscapeKey(true, onEscape))

    fireEvent.keyDown(window, { key: 'Enter' })
    fireEvent.keyDown(window, { key: 'a' })
    expect(onEscape).not.toHaveBeenCalled()
  })

  test('is inert when disabled (no listener registered)', () => {
    const onEscape = vi.fn()
    renderHook(() => useEscapeKey(false, onEscape))

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onEscape).not.toHaveBeenCalled()
  })

  test('respects defaultPrevented (nested handler already handled it)', () => {
    const onEscape = vi.fn()
    renderHook(() => useEscapeKey(true, onEscape))

    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    event.preventDefault()
    window.dispatchEvent(event)
    expect(onEscape).not.toHaveBeenCalled()
  })

  test('cleans up on unmount', () => {
    const onEscape = vi.fn()
    const { unmount } = renderHook(() => useEscapeKey(true, onEscape))

    unmount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onEscape).not.toHaveBeenCalled()
  })

  test('stops firing after being disabled', () => {
    const onEscape = vi.fn()
    const { rerender } = renderHook(({ enabled }: { enabled: boolean }) => useEscapeKey(enabled, onEscape), {
      initialProps: { enabled: true },
    })

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)

    rerender({ enabled: false })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
  })
})
