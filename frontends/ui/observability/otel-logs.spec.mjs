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

describe('classifyConsoleRecord', () => {
  // ERROR is the level the collector forwards to err2issue, which files a
  // GitHub issue per unique fingerprint. These cases pin which records are
  // allowed to reach it — both directions, so neither over- nor under-reporting
  // can regress silently.
  const DEBUG = { severityNumber: 5, severityText: 'DEBUG' }
  const INFO = { severityNumber: 9, severityText: 'INFO' }
  const WARN = { severityNumber: 13, severityText: 'WARN' }
  const ERROR = { severityNumber: 17, severityText: 'ERROR' }

  it('maps each console method to its own severity', async () => {
    const { classifyConsoleRecord } = await freshModule()
    expect(classifyConsoleRecord('debug', 'x')).toEqual(DEBUG)
    expect(classifyConsoleRecord('log', 'x')).toEqual(INFO)
    expect(classifyConsoleRecord('info', 'x')).toEqual(INFO)
    expect(classifyConsoleRecord('warn', 'x')).toEqual(WARN)
    expect(classifyConsoleRecord('error', 'boom: everything is on fire')).toEqual(ERROR)
  })

  it('records a Node deprecation warning at WARN (issue #230)', async () => {
    const { classifyConsoleRecord } = await freshModule()
    // Verbatim from the issue: Node's default 'warning' handler prints this
    // through console.error, so the bridge sees an ERROR-stream WARNING.
    const body =
      '(node:1) [DEP0060] DeprecationWarning: The `util._extend` API is deprecated. ' +
      'Please use Object.assign() instead.\n' +
      '(Use `node --trace-deprecation ...` to show where the warning was created)'
    expect(classifyConsoleRecord('error', body)).toEqual({
      ...WARN,
      attributes: { 'grid.severity.reclassified': 'node-process-warning' },
    })
  })

  it('covers the other Node warning shapes, coded and uncoded', async () => {
    const { classifyConsoleRecord } = await freshModule()
    for (const body of [
      '(node:1) ExperimentalWarning: The Fetch API is an experimental feature',
      '(node:1) MaxListenersExceededWarning: Possible EventEmitter memory leak detected',
      '(node:1) Warning: something the app emitted via process.emitWarning',
      '(node:1) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.',
    ]) {
      expect(classifyConsoleRecord('error', body).severityNumber, body).toBe(13)
    }
  })

  it('keeps a real error that merely mentions a warning at ERROR', async () => {
    const { classifyConsoleRecord } = await freshModule()
    // The Node pattern is anchored: only a record that OPENS with Node's own
    // "(node:<pid>) …Warning: " prefix is a process warning. An application
    // error is free to contain that text anywhere else.
    for (const body of [
      'TypeError: cannot read (node:1) DeprecationWarning: x',
      'failed to parse a DeprecationWarning: banner',
    ]) {
      expect(classifyConsoleRecord('error', body), body).toEqual(ERROR)
    }
  })

  it('records an expected NotFoundError escaping a render at WARN (issue #262)', async () => {
    const { classifyConsoleRecord } = await freshModule()
    // Verbatim from the issue: Next's server error logger formatting a
    // `NotFoundError` from `@/lib/api/errors` that escaped a server component.
    // The class name is `f` because production output is minified and
    // `ApiError` sets `this.name = new.target.name`.
    const body =
      '⨯ f: Not found\n' +
      '    at k (.next/server/chunks/ssr/[root-of-the-serve]__156qjxi._.js:1:2004)\n' +
      '    at async p (.next/server/chunks/ssr/[root-of-the-server]__0cd-yw9._.js:1:3864) {\n' +
      "  status: 404, code: 'NOT_FOUND', details: undefined, digest: '3818895446'\n" +
      '}'
    expect(classifyConsoleRecord('error', body)).toEqual({
      ...WARN,
      attributes: { 'grid.severity.reclassified': 'expected-404' },
    })
  })

  it('leaves every other ApiError status and code at ERROR', async () => {
    const { classifyConsoleRecord } = await freshModule()
    // The 404 rule must not become a general "the app threw an ApiError" rule:
    // an upstream failure or a 500 is exactly what this pipeline exists for.
    for (const envelope of [
      "  status: 502, code: 'UPSTREAM_ERROR', details: undefined",
      "  status: 500, code: 'INTERNAL', details: undefined",
      "  status: 404, code: 'UPSTREAM_ERROR', details: undefined",
      "  status: 403, code: 'FORBIDDEN', details: undefined",
    ]) {
      expect(classifyConsoleRecord('error', `⨯ f: boom {\n${envelope}\n}`), envelope).toEqual(ERROR)
    }
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

  it('actually exports records end-to-end (regression: SDK 2.x processor ctor)', async () => {
    // SDK 2.x BatchLogRecordProcessor takes { exporter } — positional
    // construction left _exporter undefined and every flush threw inside the
    // processor (swallowed by diag), so init looked fine but nothing ever
    // landed. This test asserts a real POST reaches the collector endpoint.
    const http = await import('node:http')
    const received = []
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        received.push({ url: req.url, body: Buffer.concat(chunks) })
        res.writeHead(200, { 'content-type': 'application/x-protobuf' })
        res.end()
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      // The api-logs global registry survives vi.resetModules(), so the
      // provider registered by the test above would swallow this one.
      const { logs } = await import('@opentelemetry/api-logs')
      logs.disable()

      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', `http://127.0.0.1:${server.address().port}`)
      const { initOtelLogs } = await freshModule()
      expect(initOtelLogs()).toBe(true)

      console.warn('e2e export assertion record')
      await logs.getLoggerProvider().forceFlush()

      expect(received.length).toBeGreaterThan(0)
      expect(received[0].url).toBe('/v1/logs')
      expect(received[0].body.length).toBeGreaterThan(0)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  }, 15000)

  it('emits the classified severity, not the console method (issues #230, #262)', async () => {
    // The classification is only worth anything if the patched console.* is
    // what applies it — a correct pure function wired to nothing still files
    // the issue. This asserts on the record the bridge actually hands the SDK.
    const { logs } = await import('@opentelemetry/api-logs')
    logs.disable()
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:1/v1/logs')
    const { initOtelLogs } = await freshModule()

    // Pre-patch mock: the bridge binds the then-current console.error as its
    // passthrough, keeping the record out of the test runner's output.
    const passthrough = vi.fn()
    const origError = console.error
    console.error = passthrough
    try {
      expect(initOtelLogs()).toBe(true)
      const emit = vi.spyOn(logs.getLogger('grid-console'), 'emit')

      console.error('(node:1) [DEP0060] DeprecationWarning: The `util._extend` API is deprecated.')
      console.error("⨯ f: Not found {\n  status: 404, code: 'NOT_FOUND', details: undefined\n}")
      console.error('TypeError: a genuine unhandled failure')

      expect(emit.mock.calls.map(([record]) => record.severityNumber)).toEqual([13, 13, 17])
      expect(emit.mock.calls.map(([record]) => record.attributes)).toEqual([
        { 'grid.severity.reclassified': 'node-process-warning' },
        { 'grid.severity.reclassified': 'expected-404' },
        undefined,
      ])
      expect(passthrough).toHaveBeenCalledTimes(3)
    } finally {
      console.error = origError
    }
  })
})
