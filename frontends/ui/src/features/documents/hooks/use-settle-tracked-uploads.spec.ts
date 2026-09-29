import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useDocumentsStore } from '../store'
import type { TrackedFile } from '../types'
import { useSettleTrackedUploads } from './use-settle-tracked-uploads'

const upload = (overrides: Partial<TrackedFile>): TrackedFile => ({
  id: 'local-1',
  fileName: 'Bericht.docx',
  fileSize: 10,
  status: 'ingesting',
  progress: 0,
  collectionName: 'p-1',
  serverFileId: 'doc-1',
  ...overrides,
})

const trackedStatus = (id: string) => useDocumentsStore.getState().trackedFiles.find((f) => f.id === id)?.status

describe('useSettleTrackedUploads', () => {
  beforeEach(() => {
    useDocumentsStore.setState({ trackedFiles: [] })
  })

  it('settles a jobless upload (a detached conversion) from the listing', () => {
    const row = upload({})
    useDocumentsStore.setState({ trackedFiles: [row] })

    const { rerender } = renderHook(({ docs }) => useSettleTrackedUploads(docs, [row]), {
      initialProps: { docs: [{ id: 'doc-1', status: 'processing' }] },
    })
    // Still converting: not finished early.
    expect(trackedStatus('local-1')).toBe('ingesting')

    rerender({ docs: [{ id: 'doc-1', status: 'completed' }] })
    expect(trackedStatus('local-1')).toBe('success')
  })

  it('carries a failure and its reason', () => {
    const row = upload({})
    useDocumentsStore.setState({ trackedFiles: [row] })

    renderHook(() =>
      useSettleTrackedUploads([{ id: 'doc-1', status: 'failed', errorMessage: 'Kaputt' }], [row])
    )

    const settled = useDocumentsStore.getState().trackedFiles[0]
    expect(settled.status).toBe('failed')
    expect(settled.errorMessage).toBe('Kaputt')
  })

  it('leaves a row with an ingest job to the orchestrator', () => {
    const row = upload({ jobId: 'job-1' })
    useDocumentsStore.setState({ trackedFiles: [row] })

    renderHook(() => useSettleTrackedUploads([{ id: 'doc-1', status: 'completed' }], [row]))

    expect(trackedStatus('local-1')).toBe('ingesting')
  })

  describe('a row the listing does not carry', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('settles from its own status while „Von Piloti" narrows the listing', async () => {
      // The filter makes the listing agent-authored rows only, so a person's
      // detached upload is never in it and used to spin forever in the tray.
      vi.useFakeTimers()
      const row = upload({})
      useDocumentsStore.setState({ trackedFiles: [row] })
      let status = 'processing'
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'doc-1', status }), { status: 200 }))

      const agentOnly = [{ id: 'doc-agent', status: 'completed' }]
      renderHook(() => useSettleTrackedUploads(agentOnly, [row], { fetcher: fetcher as unknown as typeof fetch }))

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000)
      })
      expect(fetcher).toHaveBeenCalledWith('/api/documents/doc-1/status', expect.anything())
      expect(trackedStatus('local-1')).toBe('ingesting')

      status = 'completed'
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000)
      })
      expect(trackedStatus('local-1')).toBe('success')
    })

    it('asks nothing for a row the listing already answers for', async () => {
      vi.useFakeTimers()
      const row = upload({})
      useDocumentsStore.setState({ trackedFiles: [row] })
      const fetcher = vi.fn()

      renderHook(() =>
        useSettleTrackedUploads([{ id: 'doc-1', status: 'processing' }], [row], {
          fetcher: fetcher as unknown as typeof fetch,
        })
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000)
      })
      expect(fetcher).not.toHaveBeenCalled()
    })
  })
})
