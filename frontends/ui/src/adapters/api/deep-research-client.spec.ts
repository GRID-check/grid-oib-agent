import { afterEach, describe, expect, test, vi } from 'vitest'
import { createDeepResearchClient, getJobStatus, type DeepResearchCallbacks } from './deep-research-client'
import { ApiRequestError } from './api-error'

/**
 * Minimal EventSource fake: records the URL it was opened with and lets tests
 * dispatch typed SSE events into the client's handlers.
 */
class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static instances: FakeEventSource[] = []

  url: string
  readyState = FakeEventSource.OPEN
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED
  }

  emit(type: string, data: unknown, lastEventId = ''): void {
    const event = { data: JSON.stringify(data), lastEventId } as MessageEvent
    this.listeners.get(type)?.forEach((listener) => listener(event))
  }
}

const connectWithFakeEventSource = (
  callbacks: DeepResearchCallbacks = {},
  options: { jobId?: string; lastEventId?: string } = {}
) => {
  vi.stubGlobal('EventSource', FakeEventSource)
  const client = createDeepResearchClient({
    jobId: options.jobId ?? 'job-1',
    lastEventId: options.lastEventId,
    callbacks,
  })
  client.connect()
  const source = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  return { client, source }
}

describe('deep research SSE client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    FakeEventSource.instances = []
  })

  describe('stream URL construction', () => {
    test('connects to the plain stream URL for a fresh job', () => {
      const { source } = connectWithFakeEventSource()

      expect(source.url).toBe('/api/jobs/async/job/job-1/stream')
    })

    test('resumes from the /stream/{last_event_id} URL when a last event id is provided', () => {
      const { source } = connectWithFakeEventSource({}, { lastEventId: '42' })

      expect(source.url).toBe('/api/jobs/async/job/job-1/stream/42')
    })

    test('tracks received event ids so a later connect resumes instead of replaying', () => {
      const { client, source } = connectWithFakeEventSource()

      source.emit('tool.start', { name: 'web_search' }, '17')

      expect(client.getLastEventId()).toBe('17')

      // A new connect on the same client resumes after the tracked id.
      client.disconnect()
      client.connect()
      const resumed = FakeEventSource.instances[FakeEventSource.instances.length - 1]
      expect(resumed.url).toBe('/api/jobs/async/job/job-1/stream/17')
    })
  })

  describe('job.status handling', () => {
    test('fires onError with a fallback message when a failure carries no error string', () => {
      const onJobStatus = vi.fn()
      const onError = vi.fn()
      const { source } = connectWithFakeEventSource({ onJobStatus, onError })

      source.emit('job.status', { data: { status: 'failure' } })

      expect(onJobStatus).toHaveBeenCalledWith('failure', undefined)
      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)
      expect((onError.mock.calls[0][0] as Error).message).toBe('Job failure')
    })

    test('does not fire onError for user-initiated cancellations', () => {
      const onError = vi.fn()
      const onJobStatus = vi.fn()
      const { source } = connectWithFakeEventSource({ onJobStatus, onError })

      source.emit('job.status', { data: { status: 'interrupted', error: 'Job cancelled by user' } })

      expect(onJobStatus).toHaveBeenCalledWith('interrupted', 'Job cancelled by user')
      expect(onError).not.toHaveBeenCalled()
    })

    test('ignores job.status events with a missing or invalid status', () => {
      const onJobStatus = vi.fn()
      const onComplete = vi.fn()
      const onError = vi.fn()
      const { source } = connectWithFakeEventSource({ onJobStatus, onComplete, onError })

      source.emit('job.status', { data: {} })
      source.emit('job.status', { data: { status: 'exploded' } })

      expect(onJobStatus).not.toHaveBeenCalled()
      expect(onComplete).not.toHaveBeenCalled()
      expect(onError).not.toHaveBeenCalled()
    })
  })
})

describe('deep research REST client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('includes proxy error details when job status lookup fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'PROXY_ERROR',
              message: 'fetch failed',
            },
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
    )

    await expect(getJobStatus('job-1')).rejects.toThrow(
      'Failed to get job status: 500 - PROXY_ERROR: fetch failed'
    )
  })

  test('attaches the HTTP status to thrown errors for structural classification', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('gone', { status: 404 }))
    )

    const error = await getJobStatus('job-1').catch((err: unknown) => err)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect((error as ApiRequestError).status).toBe(404)
  })
})
