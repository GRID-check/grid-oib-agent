import { renderHook } from '@testing-library/react'
import { describe, test, expect, beforeEach } from 'vitest'
import { useDocumentTitle } from './use-document-title'

describe('useDocumentTitle', () => {
  beforeEach(() => {
    document.title = 'Base — Grid'
  })

  test('leaves the title untouched when passed null', () => {
    renderHook(() => useDocumentTitle(null))
    expect(document.title).toBe('Base — Grid')
  })

  test('overrides the title while mounted', () => {
    renderHook(() => useDocumentTitle('Override — Grid'))
    expect(document.title).toBe('Override — Grid')
  })

  test('restores the previous title on unmount', () => {
    const { unmount } = renderHook(() => useDocumentTitle('Override — Grid'))
    expect(document.title).toBe('Override — Grid')

    unmount()
    expect(document.title).toBe('Base — Grid')
  })

  test('restores the previous title when the override is dropped', () => {
    const { rerender } = renderHook(({ title }: { title: string | null }) => useDocumentTitle(title), {
      initialProps: { title: 'Override — Grid' as string | null },
    })
    expect(document.title).toBe('Override — Grid')

    rerender({ title: null })
    expect(document.title).toBe('Base — Grid')
  })

  test('tracks a changing override and still restores the original base', () => {
    const { rerender, unmount } = renderHook(
      ({ title }: { title: string | null }) => useDocumentTitle(title),
      { initialProps: { title: '10% — Grid' as string | null } },
    )
    expect(document.title).toBe('10% — Grid')

    rerender({ title: '50% — Grid' })
    expect(document.title).toBe('50% — Grid')

    unmount()
    expect(document.title).toBe('Base — Grid')
  })
})
