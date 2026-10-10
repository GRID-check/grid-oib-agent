/**
 * Ticket 5: „Ausgeschlossene Dateien werden überhaupt nicht übertragen, auch
 * nicht kurzzeitig." (ADR-0086)
 *
 * A file name is part of what is excluded: „Lohnzettel_Mai_Huber.pdf" says it
 * all. These specs drive the decision hook through the REAL policy loader and
 * the REAL name-probe client against a recording `fetch`, and hold that no
 * request, URL or body, carries the name of a file the office's policy holds
 * back, and that nothing at all is sent while the policy is unknown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import {
  forgetPendingUploadScreeningPolicyRead,
  UploadScreeningPolicyUnavailableError,
} from '@/adapters/api/upload-screening-policy'
import { createDocumentNameProbeClient, PROJECT_NAME_PROBE_PATH } from '@/lib/documents/name-probe-client'
import type { DocumentNameMatch } from '@/lib/documents/name-probe-types'
import { SUGGESTED_SCREENING_POLICY, type UploadScreeningPolicy } from '@/lib/upload-screening/policy'
import { digestFiles } from '../lib/content-digest'
import { useUploadDecision, type SettledPlan } from './use-upload-decision'

vi.mock('../lib/content-digest', () => ({ digestFiles: vi.fn().mockResolvedValue(new Map()) }))

/** The office added its own term: „Huber" is a person, and only this office knows it. */
const OFFICE_POLICY: UploadScreeningPolicy = {
  ...SUGGESTED_SCREENING_POLICY,
  nameTerms: [...SUGGESTED_SCREENING_POLICY.nameTerms, 'Huber'],
}

interface RecordedRequest {
  url: string
  method: string
  body: string
}

let requests: RecordedRequest[]
let policyResponse: () => Response
let shelf: DocumentNameMatch[]

function match(filename: string): DocumentNameMatch {
  return {
    id: `doc-${filename}`,
    filename,
    displayName: null,
    fileSize: 1,
    contentHash: null,
    folderId: null,
    authoredBy: 'user',
    lifecycle: 'active',
  }
}

beforeEach(() => {
  forgetPendingUploadScreeningPolicyRead()
  requests = []
  shelf = []
  policyResponse = () =>
    Response.json({ policy: OFFICE_POLICY, suggested: false, suggestion: SUGGESTED_SCREENING_POLICY })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const body = typeof init?.body === 'string' ? init.body : ''
      requests.push({ url, method: init?.method ?? 'GET', body })
      if (url === '/api/organization/upload-screening') return policyResponse()
      if (url === PROJECT_NAME_PROBE_PATH) {
        const names = (JSON.parse(body) as { names: string[] }).names
        return Response.json({ documents: shelf.filter((document) => names.includes(document.filename)) })
      }
      return new Response(null, { status: 404 })
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const probe = (names: readonly string[]) => createDocumentNameProbeClient().project('p1', names)

/** Every byte of every request the browser made, for one `not.toContain`. */
const everythingSent = (): string => requests.map((request) => `${request.url}\n${request.body}`).join('\n')

describe('useUploadDecision: the name screening runs before the name probe', () => {
  it('probes only the names the policy lets through', async () => {
    const sendDirect = vi.fn()
    const { result } = renderHook(() => useUploadDecision())
    const payslip = new File(['x'], 'Lohnzettel_Mai_Huber.pdf')
    const plan = new File(['x'], 'Grundriss EG.pdf')

    await act(async () => {
      await result.current.propose(
        { files: [payslip, plan], documents: probe, folders: [], currentFolderId: null },
        sendDirect
      )
    })

    const probes = requests.filter((request) => request.url === PROJECT_NAME_PROBE_PATH)
    expect(probes).toHaveLength(1)
    expect(JSON.parse(probes[0].body)).toEqual({ projectId: 'p1', names: ['Grundriss EG.pdf'] })
    expect(everythingSent()).not.toContain('Lohnzettel')
    expect(sendDirect).not.toHaveBeenCalled()
    await waitFor(() => expect(result.current.plan?.files[0]?.action).toBe('excluded'))
  })

  it('makes no probe at all when every dropped file is held back', async () => {
    const { result } = renderHook(() => useUploadDecision())

    await act(async () => {
      await result.current.propose(
        {
          files: [new File(['x'], 'Lohnzettel_Mai_Huber.pdf'), new File(['x'], 'Honorarnote 3.pdf')],
          documents: probe,
          folders: [],
          currentFolderId: null,
        },
        vi.fn()
      )
    })

    expect(requests.map((request) => request.url)).toEqual(['/api/organization/upload-screening'])
    await waitFor(() => expect(result.current.plan?.counts.excluded).toBe(2))
  })

  it("holds back a name that matches only the office's own term", async () => {
    const { result } = renderHook(() => useUploadDecision())

    await act(async () => {
      await result.current.propose(
        { files: [new File(['x'], 'Notizen Huber.pdf')], documents: probe, folders: [], currentFolderId: null },
        vi.fn()
      )
    })

    expect(everythingSent()).not.toContain('Huber')
  })

  it('asks the probe about a file only once the reader releases it, and plans it as the version it is', async () => {
    shelf = [match('Lohnzettel_Mai_Huber.pdf')]
    const { result } = renderHook(() => useUploadDecision())
    const payslip = new File(['x'], 'Lohnzettel_Mai_Huber.pdf')

    await act(async () => {
      await result.current.propose({ files: [payslip], documents: probe, folders: [], currentFolderId: null }, vi.fn())
    })
    await waitFor(() => expect(result.current.plan?.files[0]?.action).toBe('excluded'))
    expect(everythingSent()).not.toContain('Lohnzettel')

    await act(async () => {
      await result.current.setReleased(payslip, true)
    })

    const probes = requests.filter((request) => request.url === PROJECT_NAME_PROBE_PATH)
    expect(probes.map((request) => JSON.parse(request.body).names)).toEqual([['Lohnzettel_Mai_Huber.pdf']])
    expect(result.current.plan?.files[0]).toMatchObject({
      action: 'update',
      existingId: 'doc-Lohnzettel_Mai_Huber.pdf',
      screeningReleased: true,
    })
  })

  it('holds a released file back again when the probe cannot answer for it', async () => {
    const { result } = renderHook(() => useUploadDecision())
    const payslip = new File(['x'], 'Lohnzettel_Mai_Huber.pdf')
    await act(async () => {
      await result.current.propose(
        { files: [payslip], documents: () => Promise.reject(new Error('probe down')), folders: [], currentFolderId: null },
        vi.fn()
      )
    })

    await act(async () => {
      await expect(result.current.setReleased(payslip, true)).rejects.toThrow('probe down')
    })
    expect(result.current.plan?.files[0]?.action).toBe('excluded')
  })
})

describe('useUploadDecision: releases answered out of order', () => {
  it('keeps what each of two overlapping release probes found', async () => {
    shelf = [match('A Huber.pdf'), match('B Huber.pdf')]
    const { result } = renderHook(() => useUploadDecision())
    const a = new File(['x'], 'A Huber.pdf')
    const b = new File(['x'], 'B Huber.pdf')
    await act(async () => {
      await result.current.propose({ files: [a, b], documents: probe, folders: [], currentFolderId: null }, vi.fn())
    })
    await waitFor(() => expect(result.current.plan?.counts.excluded).toBe(2))

    // Back to back: the second is asked before the first one's answer lands.
    await act(async () => {
      await Promise.all([result.current.setReleased(a, true), result.current.setReleased(b, true)])
    })

    expect(result.current.plan?.files.map((file) => [file.file.name, file.action])).toEqual([
      ['A Huber.pdf', 'update'],
      ['B Huber.pdf', 'update'],
    ])
  })

  it('keeps what a release probe found when reading the file afterwards fails', async () => {
    // Same size and a stored hash: the file is read to compare, and that read fails once.
    shelf = [{ ...match('Lohnzettel_Mai_Huber.pdf'), contentHash: 'stored' }]
    const { result } = renderHook(() => useUploadDecision())
    const payslip = new File(['x'], 'Lohnzettel_Mai_Huber.pdf')
    await act(async () => {
      await result.current.propose({ files: [payslip], documents: probe, folders: [], currentFolderId: null }, vi.fn())
    })
    await waitFor(() => expect(result.current.plan?.files[0]?.action).toBe('excluded'))

    vi.mocked(digestFiles).mockRejectedValueOnce(new Error('file unreadable'))
    await act(async () => {
      await expect(result.current.setReleased(payslip, true)).rejects.toThrow('file unreadable')
    })
    expect(result.current.plan?.files[0]?.action).toBe('excluded')

    // Released again, the name is not asked twice: what the first ask found must still count.
    await act(async () => {
      await result.current.setReleased(payslip, true)
    })
    expect(result.current.plan?.files[0]).toMatchObject({ action: 'update', screeningReleased: true })
  })
})

describe('useUploadDecision: settle, before a confirmed plan is applied', () => {
  it('waits for a release probe still in flight, so the file is planned as the version it is', async () => {
    shelf = [match('Lohnzettel_Mai_Huber.pdf')]
    const { result } = renderHook(() => useUploadDecision())
    const payslip = new File(['x'], 'Lohnzettel_Mai_Huber.pdf')
    await act(async () => {
      await result.current.propose({ files: [payslip], documents: probe, folders: [], currentFolderId: null }, vi.fn())
    })
    await waitFor(() => expect(result.current.plan?.files[0]?.action).toBe('excluded'))

    const settled: { current: SettledPlan | null } = { current: null }
    await act(async () => {
      // Not awaited: the reader confirms while the probe is still out.
      const released = result.current.setReleased(payslip, true)
      settled.current = await result.current.settle()
      await released
    })

    expect(settled.current?.plan.files[0]).toMatchObject({ action: 'update', screeningReleased: true })
  })

  it('holds back a released file whose probe fails while the reader confirms', async () => {
    const { result } = renderHook(() => useUploadDecision())
    const payslip = new File(['x'], 'Lohnzettel_Mai_Huber.pdf')
    let calls = 0
    // The release's probe fails, a moment later; any later ask would answer.
    const flaky = async (names: readonly string[]) => {
      calls += 1
      if (calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        throw new Error('probe down')
      }
      return probe(names)
    }
    await act(async () => {
      await result.current.propose({ files: [payslip], documents: flaky, folders: [], currentFolderId: null }, vi.fn())
    })

    const settled: { current: SettledPlan | null } = { current: null }
    await act(async () => {
      const released = result.current.setReleased(payslip, true).catch(() => undefined)
      settled.current = await result.current.settle()
      await released
    })

    // Not sent on the strength of a second ask the rollback then contradicts.
    expect(settled.current?.plan.files[0]?.action).toBe('excluded')
    expect(calls).toBe(1)
  })

  it('screens the plan again with a term the admin saved while the dialog was open', async () => {
    const { result } = renderHook(() => useUploadDecision())
    const minutes = new File(['x'], 'Protokoll.pdf')
    Object.defineProperty(minutes, 'webkitRelativePath', { value: 'Akt/Gruber/Protokoll.pdf', configurable: true })
    await act(async () => {
      await result.current.propose({ files: [minutes], documents: probe, folders: [], currentFolderId: null }, vi.fn())
    })
    await waitFor(() => expect(result.current.plan?.folders.map((folder) => folder.path)).toEqual(['Akt', 'Akt/Gruber']))

    policyResponse = () =>
      Response.json({
        policy: { ...OFFICE_POLICY, nameTerms: [...OFFICE_POLICY.nameTerms, 'Gruber'] },
        suggested: false,
        suggestion: SUGGESTED_SCREENING_POLICY,
      })
    const settled: { current: SettledPlan | null } = { current: null }
    await act(async () => {
      settled.current = await result.current.settle()
    })

    expect(settled.current?.plan.files[0]?.action).toBe('excluded')
    expect(settled.current?.plan.folders).toEqual([])
  })

  it('rejects when the policy cannot be read at confirm time', async () => {
    const { result } = renderHook(() => useUploadDecision())
    await act(async () => {
      await result.current.propose(
        { files: [new File(['x'], 'Notizen Huber.pdf')], documents: probe, folders: [], currentFolderId: null },
        vi.fn()
      )
    })
    await waitFor(() => expect(result.current.plan?.files[0]?.action).toBe('excluded'))

    policyResponse = () => Response.json({ error: { message: 'down' } }, { status: 503 })
    await act(async () => {
      await expect(result.current.settle()).rejects.toBeInstanceOf(UploadScreeningPolicyUnavailableError)
    })
  })
})

describe('useUploadDecision: an unknown policy sends nothing', () => {
  it('rejects without probing or sending when the policy cannot be loaded', async () => {
    policyResponse = () => Response.json({ error: { message: 'down' } }, { status: 503 })
    const sendDirect = vi.fn()
    const { result } = renderHook(() => useUploadDecision())

    let failure: unknown
    await act(async () => {
      failure = await result.current
        .propose(
          {
            files: [new File(['x'], 'Notizen Huber.pdf'), new File(['x'], 'Grundriss EG.pdf')],
            documents: probe,
            folders: [],
            currentFolderId: null,
          },
          sendDirect
        )
        .catch((error: unknown) => error)
    })

    expect(failure).toBeInstanceOf(UploadScreeningPolicyUnavailableError)
    expect(sendDirect).not.toHaveBeenCalled()
    expect(result.current.open).toBe(false)
    expect(requests.map((request) => request.url)).toEqual(['/api/organization/upload-screening'])
    expect(everythingSent()).not.toContain('Huber')
  })

  it('screens the next upload against a term the admin saved a moment ago', async () => {
    const sendDirect = vi.fn()
    const { result } = renderHook(() => useUploadDecision())
    const minutes = new File(['x'], 'Protokoll Gruber.pdf')
    const drop = { files: [minutes], documents: probe, folders: [], currentFolderId: null }

    await act(async () => {
      await result.current.propose(drop, sendDirect)
    })
    expect(sendDirect).toHaveBeenCalledTimes(1)

    // Saved in another tab: nothing on this page was told.
    policyResponse = () =>
      Response.json({
        policy: { ...OFFICE_POLICY, nameTerms: [...OFFICE_POLICY.nameTerms, 'Gruber'] },
        suggested: false,
        suggestion: SUGGESTED_SCREENING_POLICY,
      })
    requests = []
    await act(async () => {
      await result.current.propose(drop, sendDirect)
    })

    expect(sendDirect).toHaveBeenCalledTimes(1)
    expect(everythingSent()).not.toContain('Gruber')
    await waitFor(() => expect(result.current.plan?.files[0]?.action).toBe('excluded'))
  })
})
