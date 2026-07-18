import { renderHook } from '@testing-library/react'
import { describe, test, expect, beforeEach } from 'vitest'
import { useDocumentTitle } from './use-document-title'

describe('useDocumentTitle', () => {
  beforeEach(() => {
    document.title = 'Base — Piloti'
  })

  test('leaves the title untouched when passed null', () => {
    renderHook(() => useDocumentTitle(null))
    expect(document.title).toBe('Base — Piloti')
  })

  test('overrides the title while mounted', () => {
    renderHook(() => useDocumentTitle('Override — Piloti'))
    expect(document.title).toBe('Override — Piloti')
  })

  test('restores the previous title on unmount', () => {
    const { unmount } = renderHook(() => useDocumentTitle('Override — Piloti'))
    expect(document.title).toBe('Override — Piloti')

    unmount()
    expect(document.title).toBe('Base — Piloti')
  })

  test('restores the previous title when the override is dropped', () => {
    const { rerender } = renderHook(({ title }: { title: string | null }) => useDocumentTitle(title), {
      initialProps: { title: 'Override — Piloti' as string | null },
    })
    expect(document.title).toBe('Override — Piloti')

    rerender({ title: null })
    expect(document.title).toBe('Base — Piloti')
  })

  test('tracks a changing override and still restores the original base', () => {
    const { rerender, unmount } = renderHook(
      ({ title }: { title: string | null }) => useDocumentTitle(title),
      { initialProps: { title: '10% — Piloti' as string | null } },
    )
    expect(document.title).toBe('10% — Piloti')

    rerender({ title: '50% — Piloti' })
    expect(document.title).toBe('50% — Piloti')

    unmount()
    expect(document.title).toBe('Base — Piloti')
  })
})
