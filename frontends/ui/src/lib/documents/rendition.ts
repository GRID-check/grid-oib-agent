/**
 * The PDF rendition of an office document (ADR-0070).
 *
 * Word, Excel, PowerPoint, ODF and RTF files have no viewer in a browser, and
 * the product already has a good one for PDF. So the BFF — and only the BFF;
 * the Python backend never calls the converter — turns the original into a PDF
 * through Gotenberg's LibreOffice route and stores it beside the file as
 * `<dir>/_render.pdf`. The original is never touched and the download route
 * keeps handing it out; the rendition is a derived sibling like `_thumb.jpg`,
 * erased with it by `object-cleanup.ts`.
 *
 * There is no column for it. Whether the object exists IS the state, which is
 * what lets the lazy path in the preview and file routes cover every office
 * file uploaded before this module existed without a backfill.
 *
 * Which files qualify is `isOfficeRenditionSource` in `./preview-types`; this
 * module does not decide that, it only converts what it is handed.
 */

import 'server-only'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { buildRenditionStorageKey, s3Client, storageKeySegment } from '@/lib/s3'
import { NotFoundError } from '@/lib/api/errors'

/**
 * Whether the backend should extract this file's TEXT from its rendition rather
 * than from the original (ADR-0071): Word and presentation formats yes,
 * `.xlsx`/`.xlsm` no, because openpyxl keeps a sheet's structure and a printed
 * PDF of it does not.
 *
 * An alias, not a second list. The citation resolver has to agree with the
 * dispatch about which formats' locus pages are rendition pages, and it runs in
 * the browser, so the one list lives in the browser-safe `./preview-types` and
 * this name is what the dispatch reads it by.
 */
export { isIndexedFromRendition as extractsFromRendition } from './preview-types'

/**
 * How long one conversion may take. LibreOffice on a 200-slide deck or a
 * workbook with a print area of thousands of rows is slow, and a person is
 * waiting on the lazy path — two minutes is the point past which a spinner is
 * a lie rather than a wait.
 */
const GOTENBERG_TIMEOUT_MS = 120_000

/** Conversion is switched off here (`GOTENBERG_URL` unset) or impossible for this key. */
export class RenditionUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RenditionUnavailableError'
  }
}

/** The converter was asked and did not produce a PDF: an error status, a timeout, or bytes that are not one. */
export class RenditionFailedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RenditionFailedError'
  }
}

/**
 * Read at call time, not at import, like every other `process.env` read in this
 * tier: a module-level constant would freeze whatever the first import saw, and
 * the specs flip it per case.
 */
function gotenbergUrl(): string | null {
  const raw = process.env.GOTENBERG_URL?.trim()
  return raw ? raw.replace(/\/+$/, '') : null
}

/** Whether office documents can be converted in this deployment. Unset means exactly today's behaviour. */
export function isRenditionEnabled(): boolean {
  return gotenbergUrl() !== null
}

export interface EnsureRenditionInput {
  bucket: string
  /** The ORIGINAL's key; the rendition lands beside it. */
  storageKey: string
  /**
   * The name the converter sees. LibreOffice picks its import filter by the
   * extension, so this must be the original's name including it — the stored
   * type is whatever the browser sent and is not consulted.
   */
  filename: string
}

/**
 * Conversions in flight in THIS process, by bucket and key.
 *
 * The preview and the file route fire together when a viewer opens, the pane
 * and a citation chip can ask at once, and an upload's detached conversion may
 * still be running when the first reader arrives. Without this each would pay
 * a LibreOffice run and race to PUT the same object. Per process only: two BFF
 * replicas can still both convert, and both write the same bytes to the same
 * key, which is wasteful but not wrong.
 */
const inFlight = new Map<string, Promise<string>>()

/**
 * The rendition's key, converting first when it does not exist yet.
 *
 * Throws {@link RenditionUnavailableError} when conversion is disabled or the
 * key has no directory to put a sibling in, {@link RenditionFailedError} when
 * the converter fails, and `NotFoundError` when the original itself cannot be
 * read — a missing file is a 404 wherever else this tier meets one.
 */
export async function ensureRendition(input: EnsureRenditionInput): Promise<string> {
  const baseUrl = gotenbergUrl()
  if (!baseUrl) throw new RenditionUnavailableError('Office conversion is not configured (GOTENBERG_URL)')
  const renditionKey = buildRenditionStorageKey(input.storageKey)
  if (!renditionKey) throw new RenditionUnavailableError('Storage key has no directory for a rendition')

  const flightKey = `${input.bucket}\u0000${renditionKey}`
  const running = inFlight.get(flightKey)
  if (running) return running

  const flight = produceRendition(baseUrl, input, renditionKey).finally(() => {
    inFlight.delete(flightKey)
  })
  inFlight.set(flightKey, flight)
  return flight
}

async function produceRendition(
  baseUrl: string,
  input: EnsureRenditionInput,
  renditionKey: string,
): Promise<string> {
  if (await renditionExists(input.bucket, renditionKey)) return renditionKey

  const original = await readOriginal(input.bucket, input.storageKey)
  const pdf = await convert(baseUrl, original, converterFilename(input.filename, input.storageKey))

  await s3Client.send(
    new PutObjectCommand({
      Bucket: input.bucket,
      Key: renditionKey,
      Body: pdf,
      ContentType: 'application/pdf',
    }),
  )
  return renditionKey
}

/**
 * An empty object is no rendition — the same rule the thumbnail follows, for
 * the same reason: a write that died half way can leave 0 bytes that HEAD
 * reports as present and pdf.js then fails to open, for good.
 */
async function renditionExists(bucket: string, key: string): Promise<boolean> {
  try {
    const head = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return (head?.ContentLength ?? 0) > 0
  } catch {
    return false
  }
}

async function readOriginal(bucket: string, key: string): Promise<Uint8Array> {
  try {
    const object = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    if (!object.Body) throw new Error('empty body')
    return await object.Body.transformToByteArray()
  } catch {
    throw new NotFoundError('File not available')
  }
}

/**
 * The last segment of the name, made safe for a multipart header. Falls back to
 * the object key's own basename, which `storageKeySegment` built from the same
 * upload name, so the extension survives either way.
 */
function converterFilename(filename: string, storageKey: string): string {
  const fromName = filename.split('/').pop()?.trim()
  return storageKeySegment(fromName || storageKey.slice(storageKey.lastIndexOf('/') + 1))
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] // "%PDF-"

async function convert(baseUrl: string, bytes: Uint8Array, filename: string): Promise<Uint8Array> {
  const form = new FormData()
  // Copied into a plain ArrayBuffer: the SDK's bytes may sit on a shared or
  // pooled buffer, which `Blob` does not accept.
  form.append('files', new Blob([Uint8Array.from(bytes)]), filename)

  let response: Response
  try {
    response = await fetch(`${baseUrl}/forms/libreoffice/convert`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(GOTENBERG_TIMEOUT_MS),
    })
  } catch (error) {
    throw new RenditionFailedError('Office conversion did not answer', { cause: error })
  }
  if (!response.ok) {
    throw new RenditionFailedError(`Office conversion answered ${response.status}`)
  }

  const pdf = new Uint8Array(await response.arrayBuffer())
  // Checked, not trusted: a proxy's HTML error page with a 200 would otherwise
  // be stored as the rendition and served as a PDF until someone deletes it.
  if (pdf.byteLength < PDF_MAGIC.length || PDF_MAGIC.some((byte, i) => pdf[i] !== byte)) {
    throw new RenditionFailedError('Office conversion returned something that is not a PDF')
  }
  return pdf
}
