import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/mail-import/client', () => ({ sendMailArchive: vi.fn() }))

import { sendMailArchive } from '@/lib/mail-import/client'
import type { MailImportUploadPlan } from '@/lib/mail-import/types'
import {
  abortMailImportSend,
  isSameMailImportFile,
  mailImportSendSnapshot,
  runMailImportSend,
  subscribeMailImportSend,
} from './mail-import-send'

const plan = { import: { id: 'imp_1' }, partSize: 4, partCount: 3, uploadedParts: [] } as unknown as MailImportUploadPlan
const file = new File([new Uint8Array(10)], 'Büro.pst', { lastModified: 1_700_000_000_000 })

beforeEach(() => {
  vi.mocked(sendMailArchive).mockReset()
  window.localStorage.clear()
})

afterEach(() => vi.restoreAllMocks())

describe('the tab’s archive send', () => {
  it('reports progress to every subscriber and asks before the tab closes while it runs', async () => {
    let finish: () => void = () => {}
    vi.mocked(sendMailArchive).mockImplementation(async (_project, _plan, _file, onProgress) => {
      onProgress({ sentBytes: 4, totalBytes: 10, phase: 'sending' })
      await new Promise<void>((resolve) => (finish = resolve))
      return {} as never
    })
    const listener = vi.fn()
    const unsubscribe = subscribeMailImportSend(listener)

    const running = runMailImportSend('p1', plan, file)
    expect(mailImportSendSnapshot().send).toMatchObject({ projectId: 'p1', importId: 'imp_1', sentBytes: 4 })
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)

    finish()
    await running
    expect(mailImportSendSnapshot()).toEqual({ send: null, failure: null })
    const after = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })

  it('keeps a failure for the dialog, but not the abort a cancel caused', async () => {
    vi.mocked(sendMailArchive).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await runMailImportSend('p1', plan, file)
    expect(mailImportSendSnapshot().failure).toMatchObject({ projectId: 'p1', stage: 'send' })

    vi.mocked(sendMailArchive).mockImplementationOnce(
      (_p, _plan, _f, _progress, signal) =>
        new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted'))))
    )
    const running = runMailImportSend('p1', plan, file)
    abortMailImportSend('imp_1')
    await running
    expect(mailImportSendSnapshot().failure).toBeNull()
  })

  it('refuses to resume from a file that changed since the send began, and forgets it once sent', async () => {
    vi.mocked(sendMailArchive).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await runMailImportSend('p1', plan, file)

    const rewritten = new File([new Uint8Array(10)], 'Büro.pst', { lastModified: 1_700_000_999_000 })
    expect(isSameMailImportFile('imp_1', rewritten)).toBe(false)
    expect(isSameMailImportFile('imp_1', file)).toBe(true)
    expect(isSameMailImportFile('imp_other', rewritten)).toBe(true)

    vi.mocked(sendMailArchive).mockResolvedValueOnce({} as never)
    await runMailImportSend('p1', plan, file)
    expect(isSameMailImportFile('imp_1', rewritten)).toBe(true)
  })
})
