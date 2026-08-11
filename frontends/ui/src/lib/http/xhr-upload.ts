/**
 * Upload a request body with real, byte-level progress.
 *
 * This is the one place in the app that reaches for `XMLHttpRequest` on
 * purpose. `fetch` cannot report REQUEST-upload progress — the browser exposes
 * no event for bytes leaving the machine, only for bytes arriving — so a
 * progress bar built on `fetch` has nothing truthful to show and has to invent
 * a number. Every "stuck at 15%" bar in a web app is that invention.
 *
 * Response bodies are returned as text and parsed by the caller: this module
 * knows about transport, not about anyone's payload schema.
 */

/** A non-2xx response. Carries the body so callers can lift the server's reason. */
export class XhrUploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseText: string
  ) {
    super(message)
    this.name = 'XhrUploadError'
  }
}

export interface XhrUploadOptions {
  url: string
  body: FormData | Blob | ArrayBuffer | string
  method?: string
  headers?: Record<string, string>
  /**
   * Bytes sent so far and the total the browser expects to send. `total`
   * includes multipart framing, so it is larger than the sum of the file
   * sizes — attribute payload bytes with that in mind.
   */
  onProgress?: (loaded: number, total: number) => void
  /** Aborts the request; the promise rejects with an `AbortError` DOMException. */
  signal?: AbortSignal
  /** Milliseconds of total inactivity before the request is abandoned. 0 disables. */
  timeoutMs?: number
}

/** Reject shape for an aborted upload — matches what `fetch` produces. */
const abortError = (): DOMException => new DOMException('Upload aborted', 'AbortError')

/**
 * POST `body` to `url`, resolving with the response text on 2xx.
 *
 * @throws {XhrUploadError} on a non-2xx response (with status + body)
 * @throws {DOMException} named `AbortError` when `signal` fires
 * @throws {Error} on a transport failure or timeout
 */
export function xhrUpload(options: XhrUploadOptions): Promise<string> {
  const { url, body, method = 'POST', headers, onProgress, signal, timeoutMs = 0 } = options

  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }

    const xhr = new XMLHttpRequest()
    xhr.open(method, url, true)

    for (const [name, value] of Object.entries(headers ?? {})) {
      xhr.setRequestHeader(name, value)
    }

    // Deliberately NOT set for FormData: the browser has to author the
    // `multipart/form-data` Content-Type itself so it can append the boundary.
    if (timeoutMs > 0) xhr.timeout = timeoutMs

    const onAbort = () => xhr.abort()
    signal?.addEventListener('abort', onAbort, { once: true })

    const settle = (finish: () => void) => {
      signal?.removeEventListener('abort', onAbort)
      finish()
    }

    if (onProgress) {
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress(event.loaded, event.total)
      })
    }

    xhr.addEventListener('load', () => {
      settle(() => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.responseText)
        } else {
          reject(new XhrUploadError(`Upload failed with status ${xhr.status}`, xhr.status, xhr.responseText))
        }
      })
    })

    xhr.addEventListener('error', () => {
      settle(() => reject(new Error('Upload failed: network error')))
    })

    xhr.addEventListener('timeout', () => {
      settle(() => reject(new Error('Upload failed: timed out')))
    })

    xhr.addEventListener('abort', () => {
      settle(() => reject(abortError()))
    })

    xhr.send(body)
  })
}
