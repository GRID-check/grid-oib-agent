/**
 * @vitest-environment node
 *
 * The office → PDF rendition (ADR-0070). The object's existence is its only
 * state, so these pin the three things that make that safe: an existing
 * rendition is reused and never re-converted, a failed conversion writes
 * nothing, and concurrent readers share one conversion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'

vi.mock('server-only', () => ({}))

const send = vi.hoisted(() => vi.fn())
vi.mock('@/lib/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/s3')>()),
  s3Client: { send: (...args: unknown[]) => send(...args) },
}))

import { NotFoundError } from '@/lib/api/errors'
import {
  RenditionFailedError,
  RenditionUnavailableError,
  ensureRendition,
  isRenditionEnabled,
} from './rendition'

const INPUT = {
  bucket: 'test-bucket',
  storageKey: 'org/org-1/project/proj-1/doc/doc-1/v1/Baubeschreibung.docx',
  filename: 'Baubeschreibung.docx',
}
const RENDITION_KEY = 'org/org-1/project/proj-1/doc/doc-1/v1/_render.pdf'
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n…')
const DOCX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04])

const commands = () => send.mock.calls.map(([command]) => command as unknown)
const puts = () => commands().filter((c): c is PutObjectCommand => c instanceof PutObjectCommand)

/** No rendition yet; the original is readable. */
const storeWithoutRendition = () => {
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) throw Object.assign(new Error('NotFound'), { name: 'NotFound' })
    if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => DOCX_BYTES } }
    return {}
  })
}

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubEnv('GOTENBERG_URL', 'http://gotenberg:3000/')
  fetchSpy = vi.fn().mockResolvedValue(new Response(PDF_BYTES, { status: 200 }))
  vi.stubGlobal('fetch', fetchSpy)
  storeWithoutRendition()
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('isRenditionEnabled', () => {
  it('follows GOTENBERG_URL', () => {
    expect(isRenditionEnabled()).toBe(true)
    vi.stubEnv('GOTENBERG_URL', '')
    expect(isRenditionEnabled()).toBe(false)
    vi.stubEnv('GOTENBERG_URL', '   ')
    expect(isRenditionEnabled()).toBe(false)
  })
})

describe('ensureRendition', () => {
  it('converts the original through Gotenberg and stores the PDF beside it', async () => {
    await expect(ensureRendition(INPUT)).resolves.toBe(RENDITION_KEY)

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://gotenberg:3000/forms/libreoffice/convert')
    expect(init.method).toBe('POST')
    // LibreOffice picks its import filter by extension, so the original name
    // must travel with the bytes.
    const file = (init.body as FormData).get('files') as File
    expect(file.name).toBe('Baubeschreibung.docx')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(DOCX_BYTES)

    const [put] = puts()
    expect(put.input).toMatchObject({ Bucket: 'test-bucket', Key: RENDITION_KEY, ContentType: 'application/pdf' })
    expect(put.input.Body).toEqual(PDF_BYTES)
  })

  it('reuses a rendition that already exists and never calls the converter', async () => {
    send.mockResolvedValue({ ContentLength: 1024 })

    await expect(ensureRendition(INPUT)).resolves.toBe(RENDITION_KEY)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(puts()).toHaveLength(0)
  })

  it('treats an empty object as no rendition and converts again', async () => {
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) return { ContentLength: 0 }
      if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => DOCX_BYTES } }
      return {}
    })

    await ensureRendition(INPUT)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(puts()).toHaveLength(1)
  })

  it('shares one conversion between concurrent callers for the same key', async () => {
    const [a, b] = await Promise.all([ensureRendition(INPUT), ensureRendition(INPUT)])
    expect(a).toBe(RENDITION_KEY)
    expect(b).toBe(RENDITION_KEY)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(puts()).toHaveLength(1)
  })

  it('names the last path segment only, so a Piloti name with slashes stays one part', async () => {
    await ensureRendition({ ...INPUT, filename: 'piloti/doc-1/bericht.docx' })
    const file = ((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as FormData).get('files') as File
    expect(file.name).toBe('bericht.docx')
  })

  it('is unavailable when conversion is not configured, and touches nothing', async () => {
    vi.stubEnv('GOTENBERG_URL', '')
    await expect(ensureRendition(INPUT)).rejects.toBeInstanceOf(RenditionUnavailableError)
    expect(send).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('is unavailable for a key with no directory to put a sibling in', async () => {
    await expect(ensureRendition({ ...INPUT, storageKey: 'Baubeschreibung.docx' })).rejects.toBeInstanceOf(
      RenditionUnavailableError,
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('fails, and writes nothing, when Gotenberg answers an error', async () => {
    fetchSpy.mockResolvedValue(new Response('LibreOffice crashed', { status: 503 }))
    await expect(ensureRendition(INPUT)).rejects.toBeInstanceOf(RenditionFailedError)
    expect(puts()).toHaveLength(0)
  })

  it('fails when Gotenberg does not answer at all (timeout, refused)', async () => {
    fetchSpy.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'))
    await expect(ensureRendition(INPUT)).rejects.toBeInstanceOf(RenditionFailedError)
    expect(puts()).toHaveLength(0)
  })

  it('refuses to store a 200 whose body is not a PDF', async () => {
    fetchSpy.mockResolvedValue(new Response('<html>gateway</html>', { status: 200 }))
    await expect(ensureRendition(INPUT)).rejects.toBeInstanceOf(RenditionFailedError)
    expect(puts()).toHaveLength(0)
  })

  it('is a 404 when the original itself is gone', async () => {
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof GetObjectCommand) throw new Error('NoSuchKey')
      throw Object.assign(new Error('NotFound'), { name: 'NotFound' })
    })
    await expect(ensureRendition(INPUT)).rejects.toBeInstanceOf(NotFoundError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('runs again after a failure — the in-flight entry does not outlive it', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('down', { status: 502 }))
    await expect(ensureRendition(INPUT)).rejects.toBeInstanceOf(RenditionFailedError)
    await expect(ensureRendition(INPUT)).resolves.toBe(RENDITION_KEY)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
