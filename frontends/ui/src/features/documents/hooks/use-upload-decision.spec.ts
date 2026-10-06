import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

vi.mock('@/adapters/api/upload-screening-policy', async () => {
  const { SUGGESTED_SCREENING_POLICY } = await import('@/lib/upload-screening/policy')
  return { loadUploadScreeningPolicy: vi.fn().mockResolvedValue(SUGGESTED_SCREENING_POLICY) }
})
vi.mock('../lib/content-digest', () => ({ digestFiles: vi.fn().mockResolvedValue(new Map()) }))

import { useUploadDecision } from './use-upload-decision'

function pathed(relativePath: string): File {
  const file = new File(['x'], relativePath.split('/').pop()!, { type: 'application/pdf' })
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath, configurable: true })
  return file
}

/**
 * ADR-0079: the decision hook plans every durable-shelf upload against the
 * office's screening, so what the policy names opens the dialog instead of
 * going straight out, and a release re-plans without re-reading anything.
 */
describe('useUploadDecision — upload screening', () => {
  it('opens the dialog for a loose file the policy names, instead of sending it', async () => {
    const sendDirect = vi.fn()
    const { result } = renderHook(() => useUploadDecision())
    const invoice = new File(['x'], 'Rechnung 12.pdf')

    await act(async () => {
      await result.current.propose({ files: [invoice], documents: [], folders: [], currentFolderId: null }, sendDirect)
    })

    expect(sendDirect).not.toHaveBeenCalled()
    await waitFor(() => expect(result.current.plan?.files[0]?.action).toBe('excluded'))
    expect(result.current.open).toBe(true)
  })

  it('sends a clean loose file straight out, as before', async () => {
    const sendDirect = vi.fn()
    const { result } = renderHook(() => useUploadDecision())
    const plan = new File(['x'], 'Grundriss.pdf')

    await act(async () => {
      await result.current.propose({ files: [plan], documents: [], folders: [], currentFolderId: null }, sendDirect)
    })

    expect(sendDirect).toHaveBeenCalledWith([plan])
  })

  it('re-plans a released file as what it would otherwise be', async () => {
    const { result } = renderHook(() => useUploadDecision())
    const contract = pathed('Akt/Verträge/Architektenvertrag.pdf')

    await act(async () => {
      await result.current.propose({ files: [contract], documents: [], folders: [], currentFolderId: null }, vi.fn())
    })
    await waitFor(() => expect(result.current.plan?.files[0]?.action).toBe('excluded'))
    expect(result.current.plan?.folders).toEqual([])

    act(() => result.current.setReleased(contract, true))
    expect(result.current.plan?.files[0]).toMatchObject({ action: 'new', screeningReleased: true })
    expect(result.current.plan?.folders.map((folder) => folder.path)).toEqual(['Akt', 'Akt/Verträge'])

    act(() => result.current.setReleased(contract, false))
    expect(result.current.plan?.files[0]?.action).toBe('excluded')
  })

  it('screens against the folder the reader stands in', async () => {
    const { result } = renderHook(() => useUploadDecision())
    await act(async () => {
      await result.current.propose(
        { files: [new File(['x'], '0042.pdf')], documents: [], folders: [], currentFolderId: 'f1', screeningBasePath: 'Lohnzettel' },
        vi.fn()
      )
    })
    await waitFor(() => expect(result.current.plan?.files[0]?.action).toBe('excluded'))
  })
})

describe('useUploadDecision — what the operating system left in the folder', () => {
  it('plans a dropped folder without .DS_Store, Thumbs.db or an Office lock file', async () => {
    const { result } = renderHook(() => useUploadDecision())
    const files = [
      pathed('Wohnbau Nord/EG.pdf'),
      pathed('Wohnbau Nord/.DS_Store'),
      pathed('Wohnbau Nord/Thumbs.db'),
      pathed('Wohnbau Nord/~$Baubeschreibung.docx'),
    ]

    await act(async () => {
      await result.current.propose({ files, documents: [], folders: [], currentFolderId: null }, vi.fn())
    })

    await waitFor(() => expect(result.current.plan?.files.map((entry) => entry.file.name)).toEqual(['EG.pdf']))
  })

  it('does nothing for a drop that held only such files', async () => {
    const sendDirect = vi.fn()
    const { result } = renderHook(() => useUploadDecision())

    await act(async () => {
      await result.current.propose(
        { files: [new File(['x'], '.DS_Store')], documents: [], folders: [], currentFolderId: null },
        sendDirect
      )
    })

    expect(sendDirect).not.toHaveBeenCalled()
    expect(result.current.open).toBe(false)
  })
})
