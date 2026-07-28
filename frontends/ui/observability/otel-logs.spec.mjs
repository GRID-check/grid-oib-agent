import { afterEach, describe, expect, it, vi } from 'vitest'

async function freshModule() {
  vi.resetModules()
  return import('./otel-logs.js')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('logsUrl', () => {
  it('appends /v1/logs to the collector base URL', async () => {
    const { logsUrl } = await freshModule()
    expect(logsUrl('http://otel-collector:4318')).toBe('http://otel-collector:4318/v1/logs')
    expect(logsUrl('http://otel-collector:4318/')).toBe('http://otel-collector:4318/v1/logs')
  })

  it('rewrites a backend-style /v1/traces path', async () => {
    const { logsUrl } = await freshModule()
    expect(logsUrl('http://otel-collector:4318/v1/traces')).toBe('http://otel-collector:4318/v1/logs')
  })

  it('leaves an explicit /v1/logs path alone', async () => {
    const { logsUrl } = await freshModule()
    expect(logsUrl('http://otel-collector:4318/v1/logs')).toBe('http://otel-collector:4318/v1/logs')
  })
})

describe('initOtelLogs', () => {
  it('no-ops without OTEL_EXPORTER_OTLP_ENDPOINT (capability gate)', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
    const { initOtelLogs } = await freshModule()
    expect(initOtelLogs()).toBe(false)
  })

  it('patches console while preserving output when the endpoint is set', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://otel-collector:4318')
    vi.stubEnv('OTEL_SERVICE_NAME', 'grid-purger')
    const { initOtelLogs } = await freshModule()

    // Pre-patch mock: the bridge binds the then-current console method as the
    // passthrough, so this stands in for the original output.
    const passthrough = vi.fn()
    const origLog = console.log
    console.log = passthrough
    try {
      expect(initOtelLogs()).toBe(true)
      // Idempotent: a second call must not re-patch (no duplicate records).
      expect(initOtelLogs()).toBe(false)

      expect(() => console.log('otel bridge smoke %s', 'test')).not.toThrow()
      expect(passthrough).toHaveBeenCalledWith('otel bridge smoke %s', 'test')
    } finally {
      console.log = origLog
    }

    // And the global provider must really be the SDK one, not the no-op proxy.
    const { logs } = await import('@opentelemetry/api-logs')
    const { LoggerProvider } = await import('@opentelemetry/sdk-logs')
    expect(logs.getLoggerProvider()).toBeInstanceOf(LoggerProvider)
  })
})
