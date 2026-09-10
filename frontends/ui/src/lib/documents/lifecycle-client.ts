/**
 * The typed client for the document-lifecycle API (ADR-0055).
 *
 * ## Why a client module and not `fetch` at each call site
 *
 * ADR-0055 says every workspace primitive is an HTTP route with a typed client,
 * and that the UI, the agent's tools, the task runner and any later integration
 * are equal clients of it. A client is what makes "equal" mean something: the
 * paths, the verbs and the response shapes are written once, so a second
 * consumer cannot quietly disagree with the first about what `POST …/changes`
 * expects — and the route handlers' own specs drive the real handlers through
 * these functions, so the contract is exercised rather than described.
 *
 * Responses are PARSED with the zod schemas from `./lifecycle-types`, not cast.
 * A cast makes the compiler agree with an assumption; a parse makes the runtime
 * disagree with a wrong one, which is what a client is for when the server it
 * talks to may be a deploy ahead.
 *
 * No `server-only` and no drizzle: the browser imports this.
 */

import {
  documentArchiveResponseSchema,
  documentVersionDiffResponseSchema,
  documentVersionListResponseSchema,
  documentVersionResponseSchema,
  type DocumentArchiveResponse,
  type DocumentVersionDiffResponse,
  type DocumentVersionListResponse,
  type DocumentVersionView,
} from './lifecycle-types'

/**
 * How a request is made. Injected rather than closed over, so a route spec can
 * hand in a function that calls the real handler and a browser gets `fetch`.
 */
export type LifecycleFetch = (path: string, init?: RequestInit) => Promise<Response>

const defaultFetch: LifecycleFetch = (path, init) => fetch(path, init)

/**
 * A request the API refused, carrying the status and the body's own code.
 *
 * A typed error rather than a thrown `Response`, because every caller needs the
 * same three facts — what happened, what the server called it, and whether it is
 * worth retrying — and reading them off a `Response` at each call site is how
 * one consumer ends up treating a 409 as a 500.
 */
export class DocumentLifecycleError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'DocumentLifecycleError'
  }
}

async function request<T>(
  run: LifecycleFetch,
  path: string,
  init: RequestInit,
  parse: (value: unknown) => T,
): Promise<T> {
  const response = await run(path, init)
  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    const error = (body ?? {}) as { error?: string; code?: string; details?: unknown }
    throw new DocumentLifecycleError(
      response.status,
      error.code ?? 'UNKNOWN',
      error.error ?? `Request failed with ${response.status}`,
      error.details,
    )
  }
  return parse(body)
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export interface DocumentLifecycleClient {
  listVersions(documentId: string): Promise<DocumentVersionListResponse>
  getVersion(documentId: string, versionId: string): Promise<DocumentVersionView>
  forkDraft(documentId: string): Promise<DocumentVersionView>
  replaceContent(
    documentId: string,
    versionId: string,
    content: string,
    ifMatch: string,
  ): Promise<DocumentVersionView>
  submit(
    documentId: string,
    versionId: string,
    reviewerUserIds?: readonly string[],
  ): Promise<DocumentVersionView>
  approve(documentId: string, versionId: string, comment?: string): Promise<DocumentVersionView>
  /**
   * `delegateRevision` is the reviewer's third action: the version moves to
   * `changes_requested` either way, and with it set Piloti is additionally asked
   * to produce the next draft (`openRevisionTask`).
   */
  requestChanges(
    documentId: string,
    versionId: string,
    comment: string,
    delegateRevision?: boolean,
  ): Promise<DocumentVersionView>
  reject(documentId: string, versionId: string, comment: string): Promise<DocumentVersionView>
  publish(documentId: string, versionId: string): Promise<DocumentVersionView>
  archive(documentId: string): Promise<DocumentArchiveResponse>
  diff(documentId: string, from: string, to: string): Promise<DocumentVersionDiffResponse>
}

/** The routes of §2, as functions. One base path, spelled once. */
export function createDocumentLifecycleClient(
  run: LifecycleFetch = defaultFetch,
): DocumentLifecycleClient {
  const versions = (documentId: string) => `/api/documents/${documentId}/versions`
  const version = (documentId: string, versionId: string) =>
    `${versions(documentId)}/${versionId}`
  const one = (value: unknown) => documentVersionResponseSchema.parse(value).version

  return {
    listVersions: (documentId) =>
      request(run, versions(documentId), { method: 'GET' }, (value) =>
        documentVersionListResponseSchema.parse(value),
      ),

    getVersion: (documentId, versionId) =>
      request(run, version(documentId, versionId), { method: 'GET' }, one),

    forkDraft: (documentId) => request(run, versions(documentId), json({}), one),

    replaceContent: (documentId, versionId, content, ifMatch) =>
      request(
        run,
        `${version(documentId, versionId)}/content`,
        { ...json({ content, ifMatch }), method: 'PUT' },
        one,
      ),

    submit: (documentId, versionId, reviewerUserIds = []) =>
      request(
        run,
        `${version(documentId, versionId)}/submit`,
        json({ reviewerUserIds: [...reviewerUserIds] }),
        one,
      ),

    approve: (documentId, versionId, comment) =>
      request(
        run,
        `${version(documentId, versionId)}/approve`,
        json(comment === undefined ? {} : { comment }),
        one,
      ),

    requestChanges: (documentId, versionId, comment, delegateRevision) =>
      request(
        run,
        `${version(documentId, versionId)}/changes`,
        // Omitted rather than sent as `false`: the schema is `.strict()` and an
        // absent optional is the same decision as a false one, so the wire stays
        // exactly what it was for every caller that does not use the third action.
        json(delegateRevision ? { comment, delegateRevision: true } : { comment }),
        one,
      ),

    reject: (documentId, versionId, comment) =>
      request(run, `${version(documentId, versionId)}/reject`, json({ comment }), one),

    publish: (documentId, versionId) =>
      request(run, `${version(documentId, versionId)}/publish`, json({}), one),

    archive: (documentId) =>
      request(run, `/api/documents/${documentId}/archive`, json({}), (value) =>
        documentArchiveResponseSchema.parse(value),
      ),

    diff: (documentId, from, to) =>
      request(
        run,
        `${versions(documentId)}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        { method: 'GET' },
        (value) => documentVersionDiffResponseSchema.parse(value),
      ),
  }
}

/** The browser's instance. A route spec builds its own over the real handlers. */
export const documentLifecycleClient = createDocumentLifecycleClient()
