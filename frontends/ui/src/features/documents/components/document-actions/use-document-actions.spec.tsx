/**
 * The re-ingest half of `useDocumentActions`: what the reader is told when the
 * server refuses.
 *
 * A 409 used to read as "could not be restarted, please try again" whatever
 * its reason. For a document that was already running or already finished that
 * advice is wrong twice: there is nothing to retry, and every further click
 * answers 409 again. The server now says which (`details.code`), and the hook
 * turns it into the real state plus a fresh listing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@/test-utils'
import { http, HttpResponse } from 'msw'
import { toast } from 'sonner'
import { server } from '@/mocks/server'
import { onDocumentsChanged } from '@/lib/documents/document-changes'
import { INGEST_ALREADY_DONE, INGEST_RUNNING } from '@/lib/documents/reingest-codes'
import { useDocumentActions } from './use-document-actions'

const DOCUMENT = { id: 'doc-1', filename: 'Einreichplan_EG.pdf', displayName: null, status: 'processing' }

function refuseWith(details: Record<string, unknown>) {
  server.use(
    http.post('/api/documents/doc-1/reingest', () =>
      HttpResponse.json({ error: 'Conflict', code: 'CONFLICT', details }, { status: 409 })
    )
  )
}

function setup() {
  const onReingested = vi.fn()
  const changed = vi.fn()
  const unsubscribe = onDocumentsChanged(changed)
  // `archiv` carries the copy in this change; the same keys are asked of `files`.
  const hook = renderHook(() => useDocumentActions({ document: DOCUMENT, scope: 'archiv', onReingested }))
  return { hook, onReingested, changed, unsubscribe }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useDocumentActions — reingest refusals', () => {
  it('says it is already being read, and refreshes, when the job is running', async () => {
    refuseWith({ status: 'processing', code: INGEST_RUNNING })
    const info = vi.spyOn(toast, 'info')
    const error = vi.spyOn(toast, 'error')
    const { hook, onReingested, changed, unsubscribe } = setup()

    let result: string | null = null
    await act(async () => {
      result = await hook.result.current.reingest()
    })

    expect(result).toBe('processing')
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/bereits gelesen|already being read/i))
    expect(error).not.toHaveBeenCalled()
    expect(onReingested).toHaveBeenCalledWith('doc-1', 'processing')
    expect(changed).toHaveBeenCalled()
    unsubscribe()
  })

  it('says it is already finished, and reports the healed status, after a heal', async () => {
    refuseWith({ status: 'completed', code: INGEST_ALREADY_DONE })
    const info = vi.spyOn(toast, 'info')
    const error = vi.spyOn(toast, 'error')
    const { hook, onReingested, changed, unsubscribe } = setup()

    await act(async () => {
      await hook.result.current.reingest()
    })

    expect(info).toHaveBeenCalledWith(expect.stringMatching(/bereits fertig|already finished/i))
    expect(error).not.toHaveBeenCalled()
    expect(onReingested).toHaveBeenCalledWith('doc-1', 'completed')
    expect(changed).toHaveBeenCalled()
    unsubscribe()
  })

  it('keeps the generic error for a refusal it has no words for', async () => {
    refuseWith({ status: 'stored', code: 'INGEST_NOT_ELIGIBLE' })
    const error = vi.spyOn(toast, 'error')
    const { hook, onReingested, unsubscribe } = setup()

    let result: string | null = 'unset'
    await act(async () => {
      result = await hook.result.current.reingest()
    })

    expect(result).toBeNull()
    expect(error).toHaveBeenCalled()
    expect(onReingested).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('reports the new status and refreshes on success', async () => {
    server.use(http.post('/api/documents/doc-1/reingest', () => HttpResponse.json({ status: 'pending' })))
    const { hook, onReingested, changed, unsubscribe } = setup()

    await act(async () => {
      await hook.result.current.reingest()
    })

    expect(onReingested).toHaveBeenCalledWith('doc-1', 'pending')
    expect(changed).toHaveBeenCalled()
    unsubscribe()
  })
})

describe('useDocumentActions — move refusals', () => {
  it('says why an IFC model cannot go into a restricted folder, instead of "try again" (ADR-0080)', async () => {
    server.use(
      http.patch('/api/documents/doc-1/folder', () =>
        HttpResponse.json({ error: 'IFC models cannot be filed in a restricted folder yet', code: 'CONFLICT' }, { status: 409 })
      )
    )
    const error = vi.spyOn(toast, 'error')
    const onMoved = vi.fn()
    const hook = renderHook(() => useDocumentActions({ document: DOCUMENT, scope: 'files', onMoved }))

    let moved: boolean | null = null
    await act(async () => {
      moved = await hook.result.current.move('f-restricted', 'Verwaltung')
    })

    expect(moved).toBe(false)
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/not everyone may read yet|den nicht alle lesen dürfen/))
    expect(onMoved).not.toHaveBeenCalled()
  })
})
