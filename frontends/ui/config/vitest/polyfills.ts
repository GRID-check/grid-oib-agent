import { TextEncoder, TextDecoder } from 'util'

globalThis.TextEncoder = TextEncoder
globalThis.TextDecoder = TextDecoder as typeof globalThis.TextDecoder

/**
 * `EventSource`, which jsdom does not implement.
 *
 * Needed by any test that renders a component subscribing to the live-event
 * channel — the inbox badge, the chat toolbar, anything using `useLiveEvents`.
 * Without it those renders throw `ReferenceError: EventSource is not defined`
 * from inside an effect, which surfaces as an unrelated-looking failure in a test
 * about navigation or layout.
 *
 * This was not needed before because the one such component defaulted its
 * feature prop to `false`, so the subscription never opened — which is to say the
 * absence of this polyfill was hiding the fact that no test had ever rendered the
 * badge in its enabled state.
 *
 * Inert on purpose: it connects to nothing and delivers nothing. A test that
 * cares about event DELIVERY should drive the hub directly rather than rely on a
 * global fake, so this stub only has to keep the effect from throwing.
 */
class InertEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2

  readonly CONNECTING = InertEventSource.CONNECTING
  readonly OPEN = InertEventSource.OPEN
  readonly CLOSED = InertEventSource.CLOSED

  readonly url: string
  readonly withCredentials = false
  readyState = InertEventSource.CONNECTING

  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string | URL) {
    this.url = String(url)
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return false
  }
  close(): void {
    this.readyState = InertEventSource.CLOSED
  }
}

if (typeof globalThis.EventSource === 'undefined') {
  globalThis.EventSource = InertEventSource as unknown as typeof globalThis.EventSource
}
