import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useIngestionCompleteToast } from './use-ingestion-complete-toast'

interface Doc {
  id: string
  filename: string
  status: string | null
}

describe('useIngestionCompleteToast', () => {
  it('does not fire for documents that are already citable on the first render', () => {
    const onCitable = vi.fn()
    renderHook(
      ({ files }) => useIngestionCompleteToast(files, onCitable),
      { initialProps: { files: [{ id: 'a', filename: 'a.pdf', status: 'completed' }] as Doc[] } }
    )
    expect(onCitable).not.toHaveBeenCalled()
  })

  it('fires once when a document transitions from processing into a citable status', () => {
    const onCitable = vi.fn()
    const { rerender } = renderHook(
      ({ files }) => useIngestionCompleteToast(files, onCitable),
      { initialProps: { files: [{ id: 'a', filename: 'a.pdf', status: 'processing' }] as Doc[] } }
    )
    expect(onCitable).not.toHaveBeenCalled()

    rerender({ files: [{ id: 'a', filename: 'a.pdf', status: 'completed' }] })
    expect(onCitable).toHaveBeenCalledTimes(1)
    expect(onCitable).toHaveBeenCalledWith({ id: 'a', filename: 'a.pdf', status: 'completed' })
  })

  it('does not re-fire for the same file across later reloads', () => {
    const onCitable = vi.fn()
    const { rerender } = renderHook(
      ({ files }) => useIngestionCompleteToast(files, onCitable),
      { initialProps: { files: [{ id: 'a', filename: 'a.pdf', status: 'pending' }] as Doc[] } }
    )

    rerender({ files: [{ id: 'a', filename: 'a.pdf', status: 'ready' }] })
    // A fresh list array (identity change) that keeps the file citable must not toast again.
    rerender({ files: [{ id: 'a', filename: 'a.pdf', status: 'ready' }] })

    expect(onCitable).toHaveBeenCalledTimes(1)
  })

  it('fires per file when several documents complete across reloads', () => {
    const onCitable = vi.fn()
    const { rerender } = renderHook(
      ({ files }) => useIngestionCompleteToast(files, onCitable),
      {
        initialProps: {
          files: [
            { id: 'a', filename: 'a.pdf', status: 'processing' },
            { id: 'b', filename: 'b.pdf', status: 'processing' },
          ] as Doc[],
        },
      }
    )

    rerender({
      files: [
        { id: 'a', filename: 'a.pdf', status: 'completed' },
        { id: 'b', filename: 'b.pdf', status: 'processing' },
      ],
    })
    rerender({
      files: [
        { id: 'a', filename: 'a.pdf', status: 'completed' },
        { id: 'b', filename: 'b.pdf', status: 'completed' },
      ],
    })

    expect(onCitable).toHaveBeenCalledTimes(2)
    expect(onCitable).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
    expect(onCitable).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }))
  })
})
