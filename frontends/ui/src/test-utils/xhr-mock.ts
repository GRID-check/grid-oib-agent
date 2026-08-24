/**
 * A driveable `XMLHttpRequest` double.
 *
 * Uploads are the one transport that cannot run on `fetch` (only XHR reports
 * request-upload progress), and the test environment has no XHR at all — so
 * anything exercising an upload needs this. It is a DRIVER, not a canned
 * response: a test advances the request through progress events, a response, a
 * network error or an abort, which is the only way to assert on a progress
 * surface's behaviour over time.
 */

type Listener = (event: unknown) => void

export class FakeXhrRequest {
  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: unknown = null
  timeout = 0
  status = 0
  responseText = ''
  sent = false
  aborted = false

  private readonly listeners = new Map<string, Listener[]>()
  private readonly uploadListeners = new Map<string, Listener[]>()

  readonly upload = {
    addEventListener: (type: string, listener: Listener): void => {
      this.add(this.uploadListeners, type, listener)
    },
  }

  open(method: string, url: string): void {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value
  }

  addEventListener(type: string, listener: Listener): void {
    this.add(this.listeners, type, listener)
  }

  send(body: unknown): void {
    this.body = body
    this.sent = true
  }

  abort(): void {
    this.aborted = true
    this.dispatch(this.listeners, 'abort', {})
  }

  // ---- test drivers -------------------------------------------------------

  /** Fire an upload progress event. */
  emitProgress(loaded: number, total: number): void {
    this.dispatch(this.uploadListeners, 'progress', { lengthComputable: true, loaded, total })
  }

  /** Complete the request with a status and body. */
  respond(status: number, responseText = ''): void {
    this.status = status
    this.responseText = responseText
    this.dispatch(this.listeners, 'load', {})
  }

  /** Fail at the transport layer (no response at all). */
  failNetwork(): void {
    this.dispatch(this.listeners, 'error', {})
  }

  /** Exceed the configured timeout. */
  timeOut(): void {
    this.dispatch(this.listeners, 'timeout', {})
  }

  private add(map: Map<string, Listener[]>, type: string, listener: Listener): void {
    const existing = map.get(type)
    if (existing) existing.push(listener)
    else map.set(type, [listener])
  }

  private dispatch(map: Map<string, Listener[]>, type: string, event: object): void {
    for (const listener of map.get(type) ?? []) listener(event)
  }
}

export interface FakeXhrHandle {
  /** Every request opened since installation, in order. */
  requests: FakeXhrRequest[]
  /** The most recent request. Throws if none was made — a clearer failure. */
  last(): FakeXhrRequest
  restore(): void
}

/**
 * Replace `globalThis.XMLHttpRequest` for the duration of a test.
 *
 * `defineProperty`, not assignment: jsdom installs `XMLHttpRequest` as a
 * non-writable accessor, so a plain `globalThis.XMLHttpRequest = …` throws in
 * the browser-like environment and silently works in the node one — the sort of
 * difference that makes a helper pass in one suite and fail in the next.
 */
export function installFakeXhr(): FakeXhrHandle {
  const requests: FakeXhrRequest[] = []
  const original = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest')

  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    configurable: true,
    writable: true,
    value: function FakeXhrConstructor() {
      const request = new FakeXhrRequest()
      requests.push(request)
      return request
    } as unknown as typeof XMLHttpRequest,
  })

  return {
    requests,
    last() {
      const request = requests[requests.length - 1]
      if (!request) throw new Error('No XMLHttpRequest was opened')
      return request
    },
    restore() {
      if (original) Object.defineProperty(globalThis, 'XMLHttpRequest', original)
      else Reflect.deleteProperty(globalThis, 'XMLHttpRequest')
    },
  }
}
