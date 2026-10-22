import 'server-only'
/**
 * Run one operation as a person, through the browser's own route handler
 * (ADR-0122).
 *
 * The call is a `Request` built from the operation's method and path and
 * handed to the route's exported handler in-process, inside
 * {@link runAsActingSession}. The handler's factory then does what it does for
 * a browser: resolves the session (now the acting one), checks the `authz`
 * declaration, charges the rate limit, opens the tenant slot and parses the
 * body with the route's own schema. Nothing here re-states a rule a route
 * already holds; the operation's zod input only shapes what the agent sends.
 *
 * In-process, not over HTTP: a loopback request would need a credential that
 * every route accepts, which is exactly the second door this design refuses.
 */

import type { AuthorizedSession } from '@/lib/auth/types'
import { type ActingOrigin, type ActingReader, runAsActingSession } from './acting-session'
import { fieldDescription } from './field-description'
import { type AgentOperation, pathParams, withInputDefaults } from './operation'
import { type UploadBody, decodeBase64 } from './upload-wire'

/** Where a dispatched request appears to come from. Never resolved; routes only parse it. */
const DISPATCH_ORIGIN = 'http://piloti.mcp.internal'

export interface OperationInput {
  /** One entry per `[name]` segment of the operation's path. */
  readonly params?: Record<string, string>
  readonly query?: Record<string, unknown>
  readonly body?: unknown
  /**
   * Sent as `If-Match`: the version the caller read. Only an operation whose
   * route reads the header (`ifMatchHeader`, the project profile) takes it; a
   * route that wants the version in its body (a document version's content and
   * decisions) declares `ifMatch` in its body schema instead. The only header an
   * operation carries; everything else a route reads from the session or the body.
   */
  readonly ifMatch?: string
}

/**
 * The most bytes of a binary answer that travel inline, as base64 in the tool
 * result. 5 MiB of file is about 7 MB of base64: what a model client can hold
 * in one turn. A larger answer is described, never sent; the agent gets a way
 * to read it in parts or as text instead.
 */
export const MAX_INLINE_BYTES = 5 * 1024 * 1024

/** A binary answer (a PDF, a Word file, a zip) read from a route. */
export interface BinaryBody {
  readonly binary: true
  readonly contentType: string | null
  /** The size when known; `null` for a stream that did not say and was cut off. */
  readonly bytes: number | null
  /** From `Content-Disposition`, when the route names the file. */
  readonly filename?: string
  /** The bytes as base64; absent when {@link tooLarge}. */
  readonly base64?: string
  readonly tooLarge?: true
}

/**
 * The most bytes of a JSON or text answer read into memory, from a route or from
 * the backend. A tool result shows at most `MAX_RESULT_CHARS`, so anything near
 * this is already an answer the agent must narrow; past it the rest is never
 * read, so a list nobody bounded cannot hold a whole response in the process.
 */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024

/** A JSON or text answer over {@link MAX_TEXT_BYTES}: not read, only described. */
export interface OversizedBody {
  readonly oversized: true
  readonly contentType: string
  /** The declared size, when the route stated one. */
  readonly bytes: number | null
}

export function isOversizedBody(value: unknown): value is OversizedBody {
  return typeof value === 'object' && value !== null && (value as { oversized?: unknown }).oversized === true
}

/** A route that answered with a redirect, usually to a presigned URL. Never followed server-side. */
export interface RedirectBody {
  readonly redirect: true
  readonly location: string
}

export function isBinaryBody(value: unknown): value is BinaryBody {
  return typeof value === 'object' && value !== null && (value as { binary?: unknown }).binary === true
}

export function isRedirectBody(value: unknown): value is RedirectBody {
  return typeof value === 'object' && value !== null && (value as { redirect?: unknown }).redirect === true
}

export interface OperationResult {
  readonly status: number
  readonly ok: boolean
  /** Parsed JSON, the text of a text response, a {@link BinaryBody} or a {@link RedirectBody}. */
  readonly body: unknown
}

export class OperationInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OperationInputError'
  }
}

/** The concrete path: each `[name]` replaced by its encoded value. */
export function resolvePath(op: AgentOperation, params: Record<string, string> = {}): string {
  const missing = pathParams(op.path).filter((name) => !params[name])
  if (missing.length > 0) {
    throw new OperationInputError(`${op.name} needs ${missing.map((name) => `params.${name}`).join(', ')}`)
  }
  return op.path.replace(/\[(?:\.\.\.)?([^\]]+)\]/g, (_, name: string) =>
    encodeURIComponent(params[name] as string),
  )
}

/** Query values as the UI sends them: scalars as strings, arrays repeated, objects as JSON. */
export function searchParamsOf(query: Record<string, unknown> = {}): URLSearchParams {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) {
      search.append(key, typeof item === 'object' ? JSON.stringify(item) : String(item))
    }
  }
  return search
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** The file name a `Content-Disposition` header carries (`filename*` first), or `undefined`. */
export function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header)?.[1]
  if (extended) {
    try {
      return decodeURIComponent(extended.trim())
    } catch {
      // Fall through to the plain form.
    }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/.exec(header)
  const name = (plain?.[1] ?? plain?.[2])?.trim().replace(/\\(.)/g, '$1')
  return name || undefined
}

/** Read at most `max` bytes of `response`; `null` as soon as it is clear there are more. */
async function readAtMost(response: Response, max: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function readBinary(response: Response, contentType: string | null): Promise<BinaryBody> {
  const size = declaredLength(response)
  const filename = filenameFromDisposition(response.headers.get('content-disposition'))
  const named = filename ? { filename } : {}
  if (size !== null && size > MAX_INLINE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return { binary: true, contentType, bytes: size, ...named, tooLarge: true }
  }
  const bytes = await readAtMost(response, MAX_INLINE_BYTES)
  if (!bytes) return { binary: true, contentType, bytes: size, ...named, tooLarge: true }
  return {
    binary: true,
    contentType,
    bytes: bytes.byteLength,
    ...named,
    base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
  }
}

/** The declared `Content-Length`, or null when absent or not a number. */
function declaredLength(response: Response): number | null {
  const header = response.headers.get('content-length')
  const value = Number(header)
  return header !== null && Number.isFinite(value) ? value : null
}

/** A JSON or text answer, streamed with the {@link MAX_TEXT_BYTES} cap the binary path has. */
async function readText(response: Response, contentType: string): Promise<string | OversizedBody> {
  const size = declaredLength(response)
  if (size !== null && size > MAX_TEXT_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return { oversized: true, contentType, bytes: size }
  }
  const bytes = await readAtMost(response, MAX_TEXT_BYTES)
  if (!bytes) return { oversized: true, contentType, bytes: size }
  return new TextDecoder().decode(bytes)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/**
 * A response body as the agent surface reads it, with every cap in place: no
 * body for 204, a redirect described and never followed, JSON parsed, text as
 * text (both {@link MAX_TEXT_BYTES} at most), anything else as a
 * {@link BinaryBody}. The one reader for a route's answer and the backend's.
 */
export async function readResponseBody(response: Response): Promise<unknown> {
  const type = response.headers.get('content-type') ?? ''
  if (response.status === 204) return null
  const location = response.headers.get('location')
  if (REDIRECT_STATUSES.has(response.status) && location) return { redirect: true, location }
  if (type.includes('json') || type.startsWith('text/')) {
    const text = await readText(response, type)
    if (typeof text !== 'string') return text
    return type.includes('json') ? parseJson(text) : text
  }
  const binary = await readBinary(response, type || null)
  // An answer with no type and no bytes is an empty success, not a file.
  return !type && binary.bytes === 0 ? null : binary
}

/**
 * A path or query key the operation does not take is refused, never dropped:
 * zod strips it and the route never reads it, so an agent sending `limit` to an
 * unpaged list was answered as though the limit held. Only plain object schemas
 * are checked; a body may be a union and is left to the route.
 */
function refuseUnknownKeys(op: AgentOperation, schema: AgentOperation['params'] | AgentOperation['query'], value: unknown, label: string): void {
  if (!schema || !('shape' in schema) || typeof value !== 'object' || value === null) return
  const known = Object.keys((schema as { shape: Record<string, unknown> }).shape)
  const unknown = Object.keys(value).filter((key) => !known.includes(key))
  if (unknown.length === 0) return
  const takes = known.length ? `it takes ${known.join(', ')}` : `it takes no ${label}`
  throw new OperationInputError(`${op.name}: ${unknown.map((key) => `${label}.${key}`).join(', ')} is not an input; ${takes}`)
}

/**
 * Check `input` against the operation's schemas, and return it as it came:
 * NOT zod's parsed output. The route parses its own input with its own schema
 * and is the gate; forwarding the parsed copy would hand it what a transform
 * made of the agent's input (a `Date` serialized back as an ISO string with a
 * time the route's date parser refuses, a default the route would not have
 * applied). A proposal stores this same original input for the same reason.
 * Throws {@link OperationInputError} for input the operation cannot take.
 */
export function validateOperationInput(op: AgentOperation, given: OperationInput): OperationInput {
  const input = withInputDefaults(given, op.inputDefaults)
  const check = (schema: AgentOperation['params'] | AgentOperation['body'], value: unknown, label: string) => {
    if (!schema) return
    const result = schema.safeParse(value ?? {})
    if (result.success) return
    const issues = result.error.issues.map((issue) => {
      const described = fieldDescription(schema, issue.path)
      return `${label}.${issue.path.join('.')}: ${issue.message}${described ? ` (${described.replace(/\.$/, '')})` : ''}`
    })
    throw new OperationInputError(`${op.name}: ${issues.join('; ')}`)
  }
  check(op.params, input.params, 'params')
  check(op.query, input.query, 'query')
  refuseUnknownKeys(op, op.params, input.params, 'params')
  refuseUnknownKeys(op, op.query, input.query, 'query')
  if (op.body) check(op.body, input.body, 'body')
  const ifMatch = typeof input.ifMatch === 'string' ? input.ifMatch : undefined
  if (ifMatch !== undefined && !op.ifMatchHeader) {
    // Never dropped silently: a version check the agent asked for and nobody made is a lost update.
    throw new OperationInputError(
      `${op.name} takes no top-level ifMatch; when its body schema has an ifMatch field, send the version there`,
    )
  }
  return {
    ...(input.params === undefined ? {} : { params: input.params }),
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(ifMatch === undefined ? {} : { ifMatch }),
  }
}

/** The multipart form the UI's uploader would send: a `file` part and the route's text fields. */
export function formDataOf(body: UploadBody): FormData {
  const form = new FormData()
  for (const [key, value] of Object.entries(body.fields ?? {})) {
    if (typeof value === 'string' && value !== '') form.append(key, value)
  }
  for (const file of body.files) {
    const bytes = decodeBase64(file.contentBase64)
    if (!bytes) throw new OperationInputError('body.files: contentBase64 is not valid base64 or is over the size cap')
    form.append('file', new File([bytes], file.name, { type: file.mimeType || 'application/octet-stream' }))
  }
  return form
}

function requestInit(op: AgentOperation, input: OperationInput): Pick<RequestInit, 'headers' | 'body'> {
  const headers: Record<string, string> = {}
  if (input.ifMatch) headers['if-match'] = input.ifMatch
  if (op.method === 'GET' || input.body === undefined) return { headers }
  if (op.bodyEncoding === 'multipart') {
    // No content-type: `Request` adds `multipart/form-data` with its boundary.
    return { headers, body: formDataOf(input.body as UploadBody) }
  }
  if (op.bodyEncoding === 'raw') {
    const bytes = decodeBase64((input.body as { contentBase64: string }).contentBase64)
    if (!bytes) throw new OperationInputError('body.contentBase64 is not valid base64 or is over the size cap')
    headers['content-type'] = 'application/octet-stream'
    // A browser states the length; the mail import checks it against the part size.
    headers['content-length'] = String(bytes.byteLength)
    return { headers, body: bytes }
  }
  headers['content-type'] = 'application/json'
  return { headers, body: JSON.stringify(input.body) }
}

/**
 * Call `op` as `session`. Route refusals come back as a result with their
 * status and the route's error envelope, exactly as the browser sees them;
 * only input the operation cannot even address throws. `reader` says who reads
 * what the route words: an agent (English) or the person applying a proposal;
 * `origin` names the proposal that application applies (`actingProposalId`).
 */
export async function callOperation(
  op: AgentOperation,
  input: OperationInput,
  session: AuthorizedSession,
  reader: ActingReader = 'person',
  origin: ActingOrigin = {},
): Promise<OperationResult> {
  const checked = validateOperationInput(op, input)
  const url = new URL(resolvePath(op, checked.params), DISPATCH_ORIGIN)
  url.search = searchParamsOf(checked.query).toString()

  const request = new Request(url, { method: op.method, ...requestInit(op, checked) })

  const routeModule = await op.load()
  const handler = routeModule[op.method]
  if (!handler) throw new Error(`${op.path} exports no ${op.method} handler`)

  const response = await runAsActingSession(
    session,
    () => handler(request, { params: Promise.resolve(checked.params ?? {}) }),
    reader,
    origin,
  )
  const body = await readResponseBody(response)
  // A redirect is an answer (the link), not a failure, though `Response.ok` is false for it.
  return { status: response.status, ok: response.ok || isRedirectBody(body), body }
}

/** @deprecated The old name; it validates and returns the original input. Use {@link validateOperationInput}. */
export const parseOperationInput = validateOperationInput
