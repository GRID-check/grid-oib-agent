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
 * what lets the lazy path in the preview and file routes cover existing office
 * files without a backfill.
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
 * How long one conversion may take at Gotenberg, counted from the moment this
 * process hands it over — never from when it was asked for, so time spent
 * waiting for a slot ({@link maxConcurrency}) is not charged to the file.
 * LibreOffice on a 200-slide deck or a workbook with a print area of thousands
 * of rows is slow, and nobody is waiting on the background conversion.
 *
 * A reader is bounded separately and shorter, by
 * {@link EnsureRenditionOptions.readerWaitMs}: the conversion it started keeps
 * this budget when the reader stops waiting, so a slow file is ready at the
 * next open instead of being converted again from scratch.
 */
const GOTENBERG_TIMEOUT_MS = 120_000

/**
 * Conversions this process runs at Gotenberg at once, unless
 * `GOTENBERG_MAX_CONCURRENCY` says otherwise.
 *
 * Gotenberg runs LibreOffice one document at a time, and its own API timeout
 * counts the time a request queues there. A project reindex or a folder upload
 * of three hundred office files would otherwise start three hundred conversions
 * at once: each holds the original in memory while it waits, and most run out of
 * time in Gotenberg's queue and fail as unconvertible. Two keeps the next request
 * ready behind the running one without queueing anything there that could time
 * out; the rest wait here, where waiting costs neither memory nor a timeout.
 */
const DEFAULT_MAX_CONCURRENCY = 2

/**
 * How long a failed conversion is remembered for readers ({@link
 * EnsureRenditionOptions.readerWaitMs}). A file LibreOffice cannot convert would
 * otherwise be converted again, in full, on every open of the viewer; for this
 * long a reader is told at once instead. The background ingest and its retry ("Erneut
 * lesen") never consult it, so a retry always really tries.
 */
const FAILURE_MEMORY_MS = 5 * 60_000

/** Bounds {@link recentFailures}; a burst of failures cannot grow it past this. */
const FAILURE_MEMORY_MAX_ENTRIES = 1_000

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

/** Whether office documents can be converted in this deployment. Unset means no conversion. */
export function isRenditionEnabled(): boolean {
  return gotenbergUrl() !== null
}

export interface EnsureRenditionOptions {
  /**
   * Set when a PERSON is waiting on this call (the preview and file routes):
   * the longest the call waits, queue and conversion together. Past it the call
   * fails with {@link RenditionFailedError} while the conversion itself carries
   * on and stores its PDF for the next open. It also puts the conversion at the
   * head of this process's queue, and a conversion of this key that failed
   * within {@link FAILURE_MEMORY_MS} fails the call at once rather than running
   * again. Left unset — the background ingest — none of that applies.
   */
  readerWaitMs?: number
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
 * Conversions of this process that failed recently, by the same key as
 * {@link inFlight}, with the time each is forgotten. See {@link FAILURE_MEMORY_MS}.
 */
const recentFailures = new Map<string, number>()

/**
 * The rendition's key, converting first when it does not exist yet.
 *
 * Throws {@link RenditionUnavailableError} when conversion is disabled or the
 * key has no directory to put a sibling in, {@link RenditionFailedError} when
 * the converter fails (or, for a reader, when it failed recently or does not
 * finish in time), and `NotFoundError` when the original itself cannot be
 * read — a missing file is a 404 wherever else this tier meets one.
 */
export async function ensureRendition(
  input: EnsureRenditionInput,
  options: EnsureRenditionOptions = {},
): Promise<string> {
  const baseUrl = gotenbergUrl()
  if (!baseUrl) throw new RenditionUnavailableError('Office conversion is not configured (GOTENBERG_URL)')
  const renditionKey = buildRenditionStorageKey(input.storageKey)
  if (!renditionKey) throw new RenditionUnavailableError('Storage key has no directory for a rendition')

  const flightKey = `${input.bucket}\u0000${renditionKey}`
  const reader = options.readerWaitMs !== undefined
  const running = inFlight.get(flightKey)
  if (running) {
    if (reader) promote(flightKey)
    return reader ? within(running, options.readerWaitMs ?? 0) : running
  }

  if (reader && failedRecently(flightKey)) {
    // Another replica may have converted it since; a HEAD is cheap, a
    // conversion is not.
    if (await renditionExists(input.bucket, renditionKey)) return renditionKey
    throw new RenditionFailedError('Office conversion failed recently and is not retried on read')
  }

  const flight = produceRendition(baseUrl, input, renditionKey, flightKey, reader)
    .then(
      (key) => {
        recentFailures.delete(flightKey)
        return key
      },
      (error: unknown) => {
        if (error instanceof RenditionFailedError) rememberFailure(flightKey)
        throw error
      },
    )
    .finally(() => {
      inFlight.delete(flightKey)
    })
  inFlight.set(flightKey, flight)
  return reader ? within(flight, options.readerWaitMs ?? 0) : flight
}

async function produceRendition(
  baseUrl: string,
  input: EnsureRenditionInput,
  renditionKey: string,
  flightKey: string,
  urgent: boolean,
): Promise<string> {
  if (await renditionExists(input.bucket, renditionKey)) return renditionKey

  // The original is read only once a slot is held, so a queue of three
  // hundred holds three hundred promises, not three hundred files.
  await acquireSlot(flightKey, urgent)
  try {
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
  } finally {
    releaseSlot()
  }
}

/**
 * The flight, or a {@link RenditionFailedError} once `ms` have passed. The
 * flight is not cancelled: it finishes, stores its PDF and clears itself.
 */
function within(flight: Promise<string>, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new RenditionFailedError(`Office conversion did not finish within ${Math.round(ms / 1000)}s`)),
      ms,
    )
  })
  return Promise.race([flight, deadline]).finally(() => clearTimeout(timer))
}

function failedRecently(flightKey: string): boolean {
  const until = recentFailures.get(flightKey)
  if (until === undefined) return false
  if (until > Date.now()) return true
  recentFailures.delete(flightKey)
  return false
}

function rememberFailure(flightKey: string): void {
  recentFailures.delete(flightKey)
  recentFailures.set(flightKey, Date.now() + FAILURE_MEMORY_MS)
  // Oldest first, by insertion order.
  while (recentFailures.size > FAILURE_MEMORY_MAX_ENTRIES) {
    const oldest = recentFailures.keys().next().value
    if (oldest === undefined) break
    recentFailures.delete(oldest)
  }
}

/**
 * The per-process bound on conversions at Gotenberg ({@link
 * DEFAULT_MAX_CONCURRENCY}). Per process like {@link inFlight}: N BFF replicas
 * may run N times this many against one Gotenberg, which is the number to size
 * `GOTENBERG_MAX_CONCURRENCY` by. Readers queue ahead of the background.
 */
interface SlotWaiter {
  flightKey: string
  start: () => void
}
let activeConversions = 0
const readerQueue: SlotWaiter[] = []
const backgroundQueue: SlotWaiter[] = []

/** Read at call time, like {@link gotenbergUrl}. */
function maxConcurrency(): number {
  const configured = Number(process.env.GOTENBERG_MAX_CONCURRENCY)
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_CONCURRENCY
}

function acquireSlot(flightKey: string, urgent: boolean): Promise<void> {
  return new Promise((start) => {
    ;(urgent ? readerQueue : backgroundQueue).push({ flightKey, start })
    drainQueue()
  })
}

function releaseSlot(): void {
  activeConversions -= 1
  drainQueue()
}

function drainQueue(): void {
  while (activeConversions < maxConcurrency()) {
    const next = readerQueue.shift() ?? backgroundQueue.shift()
    if (!next) return
    activeConversions += 1
    next.start()
  }
}

/** A reader joined a background conversion still waiting for a slot: it goes ahead. */
function promote(flightKey: string): void {
  const index = backgroundQueue.findIndex((waiter) => waiter.flightKey === flightKey)
  if (index >= 0) readerQueue.push(...backgroundQueue.splice(index, 1))
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

/**
 * The original as the Blob the multipart body carries, so the byte array the
 * SDK read is unreachable as soon as this returns: one copy of the file stays
 * in memory while it converts, not two.
 */
async function readOriginal(bucket: string, key: string): Promise<Blob> {
  let bytes: Uint8Array
  try {
    const object = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    if (!object.Body) throw new Error('empty body')
    bytes = await object.Body.transformToByteArray()
  } catch {
    throw new NotFoundError('File not available')
  }
  // `Blob` copies just the view's own range, so a view on the SDK's pooled
  // buffer goes in as it is. The type does not admit a `SharedArrayBuffer`
  // behind it, so that one case, which the SDK does not produce, is copied.
  const part = bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : Uint8Array.from(bytes)
  return new Blob([part])
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

async function convert(baseUrl: string, original: Blob, filename: string): Promise<Uint8Array> {
  const form = new FormData()
  form.append('files', original, filename)

  let response: Response
  try {
    response = await fetch(`${baseUrl}/forms/libreoffice/convert`, {
      method: 'POST',
      body: form,
      // Created here, once the slot is held: the queue is not the file's fault.
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
