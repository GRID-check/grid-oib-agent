import { renderHook } from '@testing-library/react'
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { useRouteFocus } from './use-route-focus'

let mockPathname = '/app/projects/p1'

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}))

describe('useRouteFocus', () => {
  beforeEach(() => {
    mockPathname = '/app/projects/p1'
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  const mountMain = (): HTMLElement => {
    const main = document.createElement('main')
    main.id = 'main-content'
    main.tabIndex = -1
    document.body.appendChild(main)
    return main
  }

  test('does not move focus on initial mount', () => {
    const main = mountMain()
    const focusSpy = vi.spyOn(main, 'focus')

    renderHook(() => useRouteFocus())

    expect(focusSpy).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(main)
  })

  test('focuses main-content on a pathname change', () => {
    const main = mountMain()

    const { rerender } = renderHook(() => useRouteFocus())
    expect(document.activeElement).not.toBe(main)

    mockPathname = '/app/projects/p1/files'
    rerender()

    expect(document.activeElement).toBe(main)
  })

  test('leaves focus alone when it is already inside the new content', () => {
    const main = mountMain()
    const input = document.createElement('input')
    main.appendChild(input)

    const { rerender } = renderHook(() => useRouteFocus())

    // Simulate an intentional in-content autofocus (e.g. the chat composer).
    input.focus()
    expect(document.activeElement).toBe(input)

    mockPathname = '/app/projects/p1/chat'
    rerender()

    // Focus must not be yanked to the landmark.
    expect(document.activeElement).toBe(input)
  })

  test('is a no-op when the target landmark is absent', () => {
    // No #main-content in the DOM.
    const { rerender } = renderHook(() => useRouteFocus())

    mockPathname = '/app/projects/p1/members'
    expect(() => rerender()).not.toThrow()
  })
})
